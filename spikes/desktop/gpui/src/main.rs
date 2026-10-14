mod protocol;
use gpui_kit::component::{
    Disableable, Sizable, Theme, ThemeMode,
    button::{Button, ButtonVariants},
    input::{Input, InputEvent, InputState},
    message_scroller::{MessageScroller, MessageScrollerState},
    text::{TextView, TextViewState},
};
use gpui_kit::*;
use protocol::{Connection, Update, ViewState};
use serde_json::{Value, json};
use std::collections::HashMap;

struct Body {
    source: String,
    text: Entity<TextViewState>,
}
struct Desktop {
    connection: Connection,
    state: ViewState,
    input: Entity<InputState>,
    email: Entity<InputState>,
    otp: Entity<InputState>,
    scroller: Entity<MessageScrollerState>,
    bodies: HashMap<String, Body>,
    updates: smol::channel::Sender<Update>,
    busy: bool,
    pending: Option<Value>,
    status: Option<String>,
    disconnected: bool,
    _receive: Task<()>,
    _subscriptions: Vec<Subscription>,
}
impl Desktop {
    fn new(
        connection: Connection,
        follow: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("What are we working on?"));
        let email = cx.new(|cx| InputState::new(window, cx).placeholder("Email"));
        let otp = cx.new(|cx| InputState::new(window, cx).placeholder("Email code"));
        let scroller = cx.new(|cx| MessageScrollerState::new(0, cx));
        let (updates, receive) = smol::channel::bounded(16);
        if follow {
            connection.clone().follow(updates.clone());
        }
        let task = cx.spawn_in(window, async move |view, cx| {
            while let Ok(update) = receive.recv().await {
                if view
                    .update_in(cx, |this, window, cx| {
                        match update {
                            Update::State(state) => {
                                this.disconnected = false;
                                this.apply(state, cx);
                            }
                            Update::Result(result, command) => {
                                this.busy = false;
                                match result {
                                    Ok(state) => {
                                        this.status = None;
                                        this.apply(state, cx);
                                        if matches!(command.as_str(), "send" | "mode" | "signout") {
                                            this.pending = None;
                                            this.input.update(cx, |input, cx| {
                                                input.set_value("", window, cx)
                                            });
                                        }
                                    }
                                    Err(error) => this.status = Some(error),
                                }
                            }
                            Update::Disconnected => {
                                this.disconnected = true;
                            }
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        let subscription = cx.subscribe_in(&input, window, |this, _, event, _, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                this.send(cx);
            }
            cx.notify();
        });
        Self {
            connection,
            state: ViewState::default(),
            input,
            email,
            otp,
            scroller,
            bodies: HashMap::new(),
            updates,
            busy: false,
            pending: None,
            status: None,
            disconnected: false,
            _receive: task,
            _subscriptions: vec![subscription],
        }
    }
    fn apply(&mut self, next: ViewState, cx: &mut Context<Self>) {
        if next.revision < self.state.revision {
            return;
        }
        let switched = self.state.selected != next.selected
            || self.state.mode != next.mode
            || self.state.history != next.history;
        let old_count = self.state.messages.len();
        if switched {
            self.bodies.clear();
        }
        let mut changed = Vec::new();
        for (index, message) in next.messages.iter().enumerate() {
            if let Some(body) = self.bodies.get_mut(&message.id) {
                if body.source != message.text {
                    body.text.update(cx, |text, cx| {
                        if let Some(suffix) = message.text.strip_prefix(&body.source) {
                            text.push_str(suffix, cx);
                        } else {
                            text.set_text(&message.text, cx);
                        }
                    });
                    body.source = message.text.clone();
                    changed.push(index);
                }
            } else {
                self.bodies.insert(
                    message.id.clone(),
                    Body {
                        source: message.text.clone(),
                        text: cx.new(|cx| TextViewState::markdown(&message.text, cx)),
                    },
                );
            }
        }
        self.bodies
            .retain(|id, _| next.messages.iter().any(|m| &m.id == id));
        self.scroller.update(cx, |scroll, cx| {
            if switched || next.messages.len() < old_count {
                scroll.reset(next.messages.len(), cx);
            } else if next.messages.len() > old_count {
                scroll.append(next.messages.len() - old_count, cx);
            }
            for index in changed {
                scroll.remeasure_items(index..index + 1, cx);
            }
        });
        self.state = next;
        cx.notify();
    }
    fn command(&mut self, value: Value, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.status = None;
        let connection = self.connection.clone();
        let updates = self.updates.clone();
        let command = value["type"].as_str().unwrap_or_default().to_owned();
        std::thread::spawn(move || {
            let _ = updates.send_blocking(Update::Result(connection.command(value), command));
        });
        cx.notify();
    }
    fn send(&mut self, cx: &mut Context<Self>) {
        if self.busy || self.state.streaming || (self.state.mode == "live" && !self.state.signed_in)
        {
            return;
        }
        let value = self.input.read(cx).value().to_string();
        if value.trim().is_empty() {
            return;
        }
        let command = self.pending.get_or_insert_with(|| json!({"type":"send", "text":value.trim(), "operationId":format!("gpui-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())})).clone();
        self.command(command, cx);
    }
}
impl Render for Desktop {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let paper = rgb(0xf8f6f0);
        let ink = rgb(0x272d2b);
        let muted = rgb(0x737970);
        let line = rgb(0xd7d8ce);
        let mut nav = div().flex().flex_col().gap_2();
        for chat in &self.state.chats {
            let id = chat.id.clone();
            nav = nav.child(
                div()
                    .id(SharedString::from(format!("chat-{}", chat.id)))
                    .p_3()
                    .rounded_md()
                    .bg(if chat.id == self.state.selected {
                        rgb(0xdce2d4)
                    } else {
                        rgb(0xeeeae2)
                    })
                    .cursor_pointer()
                    .child(div().text_sm().child(chat.title.clone()))
                    .child(div().text_xs().text_color(muted).child(chat.detail.clone()))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.command(json!({"type":"select","id":id}), cx)
                    })),
            );
        }
        let items: Vec<_> = self
            .state
            .messages
            .iter()
            .filter_map(|message| {
                self.bodies.get(&message.id).map(|body| {
                    let label = if message.role == "user" {
                        "You".to_string()
                    } else if message.role == "tool" {
                        message.label.clone().unwrap_or("Tool result".into())
                    } else {
                        "Goblin".into()
                    };
                    (message.id.clone(), label, body.text.clone())
                })
            })
            .collect();
        let list = MessageScroller::new("transcript", self.scroller.clone(), move |index, _, _| {
            let mut row = div().px_8().py_4().text_sm().text_color(ink);
            if let Some((_, label, body)) = items.get(index) {
                row = row
                    .child(
                        div()
                            .text_xs()
                            .mb_2()
                            .text_color(rgb(0x3e5942))
                            .child(label.clone()),
                    )
                    .child(TextView::new(body));
            }
            row
        })
        .size_full()
        .with_jump_button_label("Latest message");
        let live = self.state.mode == "live";
        let mut toolbar = div()
            .flex()
            .gap_2()
            .px_8()
            .py_2()
            .border_y_1()
            .border_color(line)
            .child(
                Button::new("mode")
                    .small()
                    .label(if live {
                        "Live dev · switch to fixture"
                    } else {
                        "Local fixture · switch to live"
                    })
                    .disabled(self.busy)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.command(
                            json!({"type":"mode","mode": if live {"fixture"} else {"live"}}),
                            cx,
                        );
                    })),
            )
            .child(
                Button::new("reconnect")
                    .small()
                    .label("Reconnect")
                    .disabled(self.busy)
                    .on_click(
                        cx.listener(|this, _, _, cx| this.command(json!({"type":"reconnect"}), cx)),
                    ),
            );
        if !live {
            toolbar = toolbar.child(
                Button::new("history")
                    .small()
                    .label(if self.state.history {
                        "Short history"
                    } else {
                        "Stress history"
                    })
                    .on_click(
                        cx.listener(|this, _, _, cx| this.command(json!({"type":"history"}), cx)),
                    ),
            );
        }
        if live && self.state.signed_in {
            toolbar = toolbar.child(Button::new("signout").small().label("Sign out").on_click(
                cx.listener(|this, _, _, cx| this.command(json!({"type":"signout"}), cx)),
            ));
        }
        let mut center = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .h_full()
            .bg(paper)
            .child(
                div()
                    .px_8()
                    .py_6()
                    .child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child("Personal agent / desktop · GPUI Kit"),
                    )
                    .child(div().text_2xl().mt_2().child(self.state.title.clone())),
            )
            .child(toolbar);
        if live && !self.state.signed_in {
            center = center.child(div().p_4().flex().flex_col().gap_2().child("Sign in to dev. Send code sends a real email; session stays in memory.")
                .child(Input::new(&self.email)).child(Input::new(&self.otp))
                .child(div().flex().gap_2().child(Button::new("code").label("Send code").disabled(self.busy).on_click(cx.listener(|this,_,_,cx|this.command(json!({"type":"code","email":this.email.read(cx).value().to_string()}),cx))))
                .child(Button::new("verify").label("Sign in").disabled(self.busy).on_click(cx.listener(|this,_,_,cx|this.command(json!({"type":"verify","email":this.email.read(cx).value().to_string(),"otp":this.otp.read(cx).value().to_string()}),cx))))));
        }
        let can_send = !self.busy
            && !self.state.streaming
            && (!live || self.state.signed_in)
            && !self.input.read(cx).value().trim().is_empty();
        center = center.child(div().flex_1().min_h_0().child(list)).child(
            div()
                .px_8()
                .pb_6()
                .child(
                    div()
                        .text_xs()
                        .text_color(muted)
                        .py_3()
                        .child(if self.disconnected {
                            "Companion disconnected. Reconnecting…".into()
                        } else {
                            self.status
                                .clone()
                                .unwrap_or_else(|| self.state.status.clone())
                        }),
                )
                .child(
                    Input::new(&self.input)
                        .id("composer-input")
                        .disabled(self.busy || self.pending.is_some()),
                )
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap_2()
                        .mt_3()
                        .child(
                            Button::new("stop")
                                .label("Stop reply")
                                .disabled(!self.state.streaming || self.busy)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.command(json!({"type":"stop"}), cx)
                                })),
                        )
                        .child(
                            Button::new("send")
                                .primary()
                                .label(if self.pending.is_some() {
                                    "Retry same message"
                                } else {
                                    "Send ↗"
                                })
                                .disabled(!can_send)
                                .on_click(cx.listener(|this, _, _, cx| this.send(cx))),
                        ),
                ),
        );
        div()
            .size_full()
            .flex()
            .bg(paper)
            .text_color(ink)
            .child(
                div()
                    .w(px(258.))
                    .h_full()
                    .flex()
                    .flex_col()
                    .p_4()
                    .gap_4()
                    .bg(rgb(0xeeeae2))
                    .border_r_1()
                    .border_color(line)
                    .child(div().text_2xl().py_4().child("g. goblin"))
                    .child(
                        Button::new("new")
                            .label("New conversation")
                            .disabled(live || self.busy)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.command(json!({"type":"new"}), cx)
                            })),
                    )
                    .child(nav)
                    .child(div().flex_1())
                    .child(
                        div()
                            .text_xs()
                            .text_color(muted)
                            .child("01 — GPUI Kit · native Rust"),
                    ),
            )
            .child(center)
    }
}
fn main() {
    let connection = Connection::load();
    application().with_assets(assets::Assets).run(move |cx| {
        init(cx);
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        Theme::change(ThemeMode::Light, None, cx);
        open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    point(px(80.), px(80.)),
                    size(px(1180.), px(820.)),
                ))),
                titlebar: Some(TitlebarOptions {
                    title: Some("Goblin · GPUI Kit spike".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            cx,
            move |window, cx| cx.new(|cx| Desktop::new(connection, true, window, cx)),
        )
        .expect("Open GPUI window");
        cx.activate(true);
    });
}

#[cfg(test)]
mod tests {
    use super::{Connection, Desktop, ViewState, protocol};
    use gpui_kit::test::TestWindowExt;
    use gpui_kit::{AppContext, TestAppContext, WindowOptions, init, open_window};

    #[gpui_kit::test]
    fn streaming_keeps_input_and_retained_markdown(cx: &mut TestAppContext) {
        cx.update(init);
        let (handle, content) = cx.update(|cx| {
            open_window(WindowOptions::default(), cx, |window, cx| {
                cx.new(|cx| {
                    Desktop::new(
                        Connection {
                            origin: "http://127.0.0.1:1".into(),
                            token: "fixture".into(),
                        },
                        false,
                        window,
                        cx,
                    )
                })
            })
            .unwrap()
        });
        let first = ViewState {
            mode: "fixture".into(),
            selected: "desktop".into(),
            title: "Test".into(),
            messages: vec![protocol::Message {
                id: "reply".into(),
                role: "assistant".into(),
                text: "Hello".into(),
                label: None,
            }],
            ..Default::default()
        };
        cx.update_window(handle, |_, window, cx| {
            content.update(cx, |view, cx| view.apply(first.clone(), cx));
            window.click("composer-input", cx);
            window.input("Retained draft 🦀", cx);
            assert_eq!(
                window.find("composer-input").value(),
                Some("Retained draft 🦀")
            );
            content.update(cx, |view, cx| {
                let entity = view.bodies["reply"].text.entity_id();
                let mut next = first.clone();
                next.messages[0].text.push_str(" world");
                view.apply(next, cx);
                assert_eq!(view.bodies["reply"].text.entity_id(), entity);
                assert_eq!(view.bodies["reply"].source, "Hello world");
                assert_eq!(view.scroller.read(cx).item_count(), 1);
                assert_eq!(view.input.read(cx).value(), "Retained draft 🦀");
            });
            window.input("!", cx);
            assert_eq!(
                window.find("composer-input").value(),
                Some("Retained draft 🦀!")
            );
        })
        .unwrap();
    }
}
