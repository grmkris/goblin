/** Fixed synthetic programs: replay demonstrates parsing, not a live model call. */
export const examples = [
  {
    id: 'hotels',
    title: 'Compare stays',
    prompt: 'Find a quiet place in Lisbon for a long weekend. Help me compare the options.',
    hint: 'Compare the stays, then choose one to continue the conversation.',
    source: `root = Stack([intro, stays])
intro = Heading("A slower weekend in Lisbon", "Three quiet stays, all a short walk from the city. Prices are sample data, per night.")
stays = Cards([
  {title: "Casa do Jardim", description: "Príncipe Real · €118 / night", detail: "A leafy courtyard and a small breakfast room.", label: "Choose Casa do Jardim"},
  {title: "Alfama House", description: "Alfama · €154 / night", detail: "River views, tiled rooms, and a quiet terrace.", label: "Choose Alfama House"},
  {title: "The Estrela", description: "Estrela · €218 / night", detail: "A garden hideaway beside the basilica.", label: "Choose The Estrela"}
])`,
  },
  {
    id: 'trip',
    title: 'Plan a weekend',
    prompt: 'Help me plan a weekend away. Ask for the details together.',
    hint: 'Fill in the details and send them to the local action receipt.',
    source: `root = Stack([intro, destination, days, pace, send])
$destination = "Lisbon"
$days = 3
$pace = "Unhurried"
intro = Heading("Make room for a little adventure", "A few details are enough to start. You can change your mind later.")
destination = TextField("destination", "Where would you like to go?", $destination)
days = NumberField("days", "How many days?", $days, 1, 14)
pace = ChoiceField("pace", "Your kind of weekend", ["Unhurried", "A bit of everything", "Packed with plans"], $pace)
send = ActionButton("Plan my weekend")`,
  },
  {
    id: 'week',
    title: 'Review the week',
    prompt: 'How did my week go? Show me what moved forward and what needs attention.',
    hint: 'Explore the chart, then ask a follow-up with the button below.',
    source: `root = Stack([intro, totals, activity, next, followup])
intro = Heading("A good week of small wins", "Your sample weekly review. The busiest day was Thursday.")
totals = Metrics([{label: "Completed", value: "24", note: "Across 5 days"}, {label: "Focus time", value: "18 h", note: "4 h more than last week"}, {label: "Still open", value: "3", note: "Nothing overdue"}])
activity = Chart('{"type":"bar","title":"Tasks completed","x":"day","series":[{"key":"tasks"}],"data":[{"day":"Mon","tasks":4},{"day":"Tue","tasks":6},{"day":"Wed","tasks":3},{"day":"Thu","tasks":8},{"day":"Fri","tasks":3}]}')
next = Note("Worth a look", "The design review, travel budget, and reading list are ready for your attention.")
followup = ActionButton("Help me plan next week")`,
  },
] as const

export type Example = (typeof examples)[number]
