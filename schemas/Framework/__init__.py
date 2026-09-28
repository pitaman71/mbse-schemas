"""Schemas framework. See Framework.md for the design."""

from . import Plain, Proxies, Schemas, Visitors

__all__ = ["Schemas", "Visitors", "Proxies", "Plain", "JSON"]


class JSON:
    """JSON serialization: `JSON.ToJSON` and `JSON.FromJSON`."""
