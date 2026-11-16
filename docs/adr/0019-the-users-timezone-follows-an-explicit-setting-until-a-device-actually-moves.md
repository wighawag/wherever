# The user's timezone follows an explicit setting until a device actually moves

**Status:** accepted

The assistant keeps one "user's current timezone" (spec `assistant-session-and-channels`, ADR 0015). Two sources write it: `assistant_set_timezone` (the user told the assistant where they are) and the web client's report of the browser's zone. As first built (`assistant-schedule-tools-server`, decision 7) every web connect overwrote the zone when it differed, so "I'm in Tokyo" was undone by the next page load of a laptop still set to Paris, and two devices in different zones kept switching it. We decided that a web report is a signal that a DEVICE MOVED, not a reading of where the user is: the web sends a report only when the browser's resolved zone differs from the last zone THAT browser reported (remembered on the device), and a device's first-ever report applies only when the current zone was not set explicitly through `assistant_set_timezone`. An explicit setting therefore stands until the user changes it again or a device's own zone really changes (travel with the laptop), and devices that never move never override it or each other.

## Considered Options

- **Last report wins** (the original behaviour): simple, but it silently undoes what the user said.
- **Explicit always wins**: robust, but then a real trip with the laptop never updates anything unless the user also tells the assistant.
- **Explicit is sticky for a fixed window** (e.g. 12 h): arbitrary, and still lets a stationary device override the user once the window ends.

## Consequences

- The timezone history keeps recording every applied change with its source (`system`, `assistant_set_timezone`, `web`); ignored reports are not changes and are not recorded.
- Clearing the browser's storage makes its next report a "first report", which applies only when there is no explicit setting.
