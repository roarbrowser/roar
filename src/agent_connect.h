// Adds Roar's MCP server to the config files of agent clients (Claude, Cursor,
// VS Code, Codex, Goose...). No CEF, so tests/agent_connect_test.cc runs alone.
#pragma once

#include <string>
#include <vector>

namespace roar::agents {

struct Client {
  std::string id, name;
  std::string file;     // Absolute config path; empty for copy-only clients.
  std::string snippet;  // What to paste by hand.
  std::string error;    // Why the config can't be read, if it can't.
  bool detected = false, connected = false;
};

// Every known client, for `home` and the server executable `server`.
std::vector<Client> List(const std::string& home, const std::string& server);

// Writes or updates the roar entry in client `id`'s config. Keeps other
// servers and the file's layout, backs the original up once as <file>.bak,
// and writes nothing when the file doesn't parse. Returns "" or an error.
std::string Connect(const std::string& id, const std::string& home, const std::string& server);

// Run before letting the `claude` CLI rewrite ~/.claude.json: backs it up once
// as .bak and returns an error if it isn't strict JSON (the CLI would drop
// what it can't parse). Returns "" when the CLI may go ahead.
std::string PrepareClaudeCli(const std::string& home);

}  // namespace roar::agents
