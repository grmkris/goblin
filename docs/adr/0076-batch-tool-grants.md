# Batch changes to exact tool grants

Accepted. Extends the owner grant controls in ADR 0060; it does not supersede their permission model.

Connections' Allow all and None formerly sent one owner request per tool or App, so each network round trip delayed
the next switch. They now submit the exact changed names through `PUT /api/mcp/grants/batch`. The owner API validates
the connection, names and direction; it accepts at most 2,000 names. The runtime discovers the connection once,
refreshes once if any requested name is missing, and reports names still absent without granting them. Newly
discovered names outside the request receive no grant.

The selected tool grants and their App-resource grants commit in one synchronous SQLite transaction. Existing
Ask first policies and grant versions survive an allow operation. Revoking needs no network; resources shared by
remaining allowed tools stay available, and removing the last tool removes the connection's App-resource grants.
Other connections and prompt grants are unchanged. Discovery failure writes nothing; a storage failure rolls the
batch back.

The response contains confirmed grants and missing names. The browser updates all switches from that response and
shows one receipt. A failed request leaves the prior display available for retry. Individual tool and App switches
keep their existing endpoints. Local host, HTTP and SQLite tests cover grant semantics; the browser fixture covers
one request, pending controls and retry. These fixtures do not establish deployed or authenticated MySI acceptance.
