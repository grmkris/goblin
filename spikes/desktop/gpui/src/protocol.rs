use serde::Deserialize;
use serde_json::Value;
use std::{
    io::{BufRead, BufReader},
    time::Duration,
};

#[derive(Clone, Deserialize)]
pub struct Connection {
    pub origin: String,
    pub token: String,
}
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewState {
    pub revision: u64,
    pub mode: String,
    pub selected: String,
    pub title: String,
    pub status: String,
    pub chats: Vec<Chat>,
    pub messages: Vec<Message>,
    pub streaming: bool,
    pub history: bool,
    pub signed_in: bool,
}
#[derive(Clone, Deserialize)]
pub struct Chat {
    pub id: String,
    pub title: String,
    pub detail: String,
}
#[derive(Clone, Deserialize)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub text: String,
    pub label: Option<String>,
}
pub enum Update {
    State(ViewState),
    Result(Result<ViewState, String>, String),
    Disconnected,
}
impl Connection {
    pub fn load() -> Self {
        let path = std::env::var("GOBLIN_DESKTOP_CONNECTION")
            .unwrap_or_else(|_| "artifacts/connection.local.json".into());
        let connection: Self = serde_json::from_str(
            &std::fs::read_to_string(path).expect("Start bun run serve first"),
        )
        .expect("valid connection file");
        let port = connection
            .origin
            .strip_prefix("http://127.0.0.1:")
            .and_then(|p| p.parse::<u16>().ok());
        assert!(
            port.is_some(),
            "Companion must be on the loopback interface"
        );
        connection
    }
    pub fn command(&self, value: Value) -> Result<ViewState, String> {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(35)))
            .build();
        let agent = ureq::Agent::new_with_config(config);
        let response = agent
            .post(format!("{}/bridge/command", self.origin))
            .header("authorization", format!("Bearer {}", self.token))
            .header("x-goblin-shell", "gpui")
            .send_json(value);
        match response {
            Ok(mut response) => response
                .body_mut()
                .read_json()
                .map_err(|_| "Invalid companion response".into()),
            Err(_) => Err("Command failed. Retry the same message, or check the companion.".into()),
        }
    }
    pub fn follow(self, sender: smol::channel::Sender<Update>) {
        std::thread::spawn(move || {
            loop {
                let response = ureq::get(format!("{}/bridge/events", self.origin))
                    .header("authorization", format!("Bearer {}", self.token))
                    .header("x-goblin-shell", "gpui")
                    .call();
                if let Ok(mut response) = response {
                    let reader = BufReader::new(response.body_mut().as_reader());
                    for line in reader.lines() {
                        let Ok(line) = line else { break };
                        if line.len() > 4 * 1024 * 1024 {
                            break;
                        }
                        if let Some(data) = line.strip_prefix("data: ") {
                            if let Ok(state) = serde_json::from_str(data) {
                                if sender.send_blocking(Update::State(state)).is_err() {
                                    return;
                                }
                            }
                        }
                    }
                }
                if sender.send_blocking(Update::Disconnected).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        });
    }
}
