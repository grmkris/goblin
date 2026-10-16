# goblin uses production mysi on every stage

Accepted (owner, 2026-10-16). Amends ADR 0052's endpoint note, which put `dev.mysi.lol` on local and dev.

goblin's shelf suggests mysi at `https://mysi.lol/mcp?codemode=off` on every stage: local, dev and prod. goblin is the
product under test on its dev stage; mysi is a separate product, and pointing goblin's dev at mysi's dev made each
test of goblin depend on whatever mysi had in flight. With mysi's stable release behind it, a failure on goblin's dev
is goblin's to explain.

Nothing in the code changes: the shelf has always named production mysi, and `MCP_SHELF` still lets a deployment that
does need mysi's dev point the `mysi` entry there. goblin's own dev stage no longer sets it. An owner who connected
mysi's dev on goblin's dev removes that connection and adds mysi from the shelf again.
