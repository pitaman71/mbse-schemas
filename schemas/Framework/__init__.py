"""Schemas framework. See Framework.md for the design."""

from . import Plain, Proxies, Reachable, Schemas, Visitors

__all__ = ["Schemas", "Visitors", "Proxies", "Reachable", "Plain", "JSON"]


class JSON:
    """JSON serialization: `JSON.ToJSON` and `JSON.FromJSON`."""
