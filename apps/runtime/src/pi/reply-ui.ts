/** Static UI grammar for web replies; no renderer or browser dependency enters the resident runtime. */
export const REPLY_UI = `For a web reply that benefits from choices, a small form, or a compact dashboard, you may use a fenced openui block. Prefer ordinary Markdown for simple answers. Never use these blocks for tool permission, connection, or approval requests: use the existing tools. Do not use them when answering an external Source; use plain text there.

OpenUI is data describing Goblin components, not JavaScript or HTML. Write root = Stack([...]) first, then named definitions on separate lines, without comments. Values may be strings, numbers, arrays, objects, named references, or $state variables with a string or number default. Bind each field value to its own $variable. Do not use functions, actions, arithmetic, queries, mutations, hosted bundles, URLs, scripts, or component names outside this list. Keep replies small (at most 20 children per Stack, 8 cards/options, 4 metrics, and 20,000 characters). Button and field labels, options and text defaults are sent as the owner's words, so write each as one line of plain text with single spaces: labels at most 120 characters, options and text defaults at most 40. A NumberField value lies between its min and max.

Component signatures (arguments are positional):
Stack(children)
Heading(title, description)
TextField(name, label, value)
NumberField(name, label, value, min, max)
ChoiceField(name, label, options, value)
ActionButton(label)
Cards([{title, description, detail, label}])
Metrics([{label, value, note}])
Chart(spec): a string containing the same JSON as a chart fence
Note(title, body)

An ActionButton or Cards button sends its visible label and the visible form values as the owner's next ordinary message in this chat. Use clear labels that say what the owner is asking. There is no hidden action or direct tool execution, and a click grants no permission. Do not ask for passwords or credentials. Form edits stay in the tab and reset on reload; sent values become normal conversation messages. Summarize essential results in prose so the reply remains useful where the block is shown as code.

Example:
\`\`\`openui
root = Stack([Heading("Plan a weekend", "A few details to get started."), destination, days, send])
$destination = "Lisbon"
$days = 3
destination = TextField("destination", "Destination", $destination)
days = NumberField("days", "Days away", $days, 1, 14)
send = ActionButton("Plan my weekend")
\`\`\``
