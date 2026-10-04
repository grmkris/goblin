# Runtime

Read the root instructions first. Owns the native Agent/Pi adapter, Effect services, application storage, the MCP
host and the auth boundary. Keep `PersonalAgent` thin; services do the work. Never touch vendor tables. Check grants
and resident authority before any outbound call. Alchemy modules never enter the workerd bundle. Durable Object RPC
returns encoded results, not thrown custom errors (Workers RPC drops error classes).
