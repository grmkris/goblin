# Runtime

Read the root instructions first. Owns the native Agent/Pi adapter, Effect services, application storage, MCP/auth
boundaries and runtime tests. Keep the class thin, protect all vendor tables, and enforce grants before execution.
Alchemy deployment modules must never enter the workerd bundle. Every test labels its evidence environment.
