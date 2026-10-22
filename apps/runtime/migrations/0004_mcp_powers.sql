-- Every MCP power is its own consent switch (ADR 0098): asking the agent (`goblin:agent`), the conversations in full
-- (`goblin:transcripts`, apart from `goblin:inspect`), what setups are chosen from (`goblin:setup`) and routines
-- (`goblin:routines`). A client registered before keeps the scope list it was registered with, which lacks them, so
-- every registration takes the whole list; the consent still decides each one.
update "oauthClient" set "scopes" = '["openid","profile","email","offline_access","goblin:agent","goblin:topics","goblin:conversations","goblin:personas","goblin:inspect","goblin:transcripts","goblin:setup","goblin:routines"]' where "scopes" is not null;
