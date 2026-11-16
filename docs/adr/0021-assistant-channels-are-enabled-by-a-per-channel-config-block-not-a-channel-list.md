# Assistant channels are enabled by a per-channel config block, not a channel list

**Status:** accepted

The spec `assistant-session-and-channels` said channels are "enabled per the config's channel list". The build instead gave each channel its own top-level block with its own `enabled` flag: `assistantWebPush` (`enabled` default ON, since nothing is sent or written until a device subscribes through the settings toggle) and `assistantTelegram` (`enabled` default OFF, since it needs a bot token and opens an internet-reachable inbox). We ratified that: every channel needs a block for its own options anyway, the defaults differ for real reasons, and a list would either duplicate the flags or need exceptions for default-on channels. Future channels (WhatsApp) follow the same `assistant<Channel>` block pattern. Channels still start only while the assistant is active (configured AND this server holds the folder lock).

## Considered Options

- **An `assistantChannels: [...]` list, with the blocks as per-channel options**: one place to see what is on, but it makes Web Push opt-in for installs that never listed it, or needs a "default-on except" rule.
