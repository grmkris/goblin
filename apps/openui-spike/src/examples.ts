/** Fixed synthetic programs: replay demonstrates parsing, not a live model call. */
export const examples = [
  {
    id: 'hotels',
    title: 'Compare stays',
    prompt: 'Find a quiet place in Lisbon for a long weekend. Help me compare the options.',
    hint: 'Change the nightly budget, then choose a stay.',
    source: `root = Stack([intro, budget, stays])
$budget = 180
intro = Heading("A slower weekend in Lisbon", "Three quiet stays, all a short walk from the city. Prices are sample data, per night.")
budget = NumberField("budget", "Nightly budget (€)", $budget, 60, 300)
stays = Hotels([
  {name: "Casa do Jardim", area: "Príncipe Real", price: 118, note: "A leafy courtyard and a small breakfast room.", tag: "Best value"},
  {name: "Alfama House", area: "Alfama", price: 154, note: "River views, tiled rooms, and a quiet terrace.", tag: "River view"},
  {name: "The Estrela", area: "Estrela", price: 218, note: "A garden hideaway beside the basilica.", tag: "A little extra"}
], $budget)`,
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
send = ActionButton("Plan my weekend", @ToAssistant("Plan my weekend", {destination: $destination, days: $days, pace: $pace}))`,
  },
  {
    id: 'week',
    title: 'Review the week',
    prompt: 'How did my week go? Show me what moved forward and what needs attention.',
    hint: 'Explore the chart, then ask a follow-up with the button below.',
    source: `root = Stack([intro, totals, activity, next, followup])
intro = Heading("A good week of small wins", "Your sample weekly review. The busiest day was Thursday.")
totals = Metrics([{label: "Completed", value: "24", note: "Across 5 days"}, {label: "Focus time", value: "18 h", note: "4 h more than last week"}, {label: "Still open", value: "3", note: "Nothing overdue"}])
activity = ActivityChart("Tasks completed", [{day: "Mon", tasks: 4}, {day: "Tue", tasks: 6}, {day: "Wed", tasks: 3}, {day: "Thu", tasks: 8}, {day: "Fri", tasks: 3}])
next = Note("Worth a look", "The design review, travel budget, and reading list are ready for your attention.")
followup = ActionButton("Help me plan next week", @ToAssistant("Help me plan next week"))`,
  },
] as const

export type Example = (typeof examples)[number]
