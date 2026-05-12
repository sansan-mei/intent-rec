from typing import Any

from dify_plugin import ToolProvider


class HeuristicProvider(ToolProvider):
    def _validate_credentials(self, credentials: dict[str, Any]) -> None:
        _ = credentials
        return
