function timeOfDayGreeting(hour) {
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// Sits above HeroCard on the Today tab - the one place in the app that
// reads as a direct address rather than a data readout, so it's where
// a name (if set - see the first-run prompt in App.jsx) actually earns
// its place. Returns null with no name rather than falling back to
// something generic like "Good morning" alone floating with nothing to
// greet - that reads like an unfinished template, not a deliberate
// choice, so it's better to just not show anything until there's a
// name to greet.
export default function Greeting({ name }) {
  if (!name) return null;
  const hour = new Date().getHours();
  return <p className="fd-greeting">{timeOfDayGreeting(hour)}, {name}.</p>;
}
