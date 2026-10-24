#!/bin/bash
# Backwards-compatible entry point for older client configs: Roar's MCP server is
# now the self-contained executable roar-mcp beside this script (no Node.js needed).
exec "$(dirname "$0")/roar-mcp" "$@"
