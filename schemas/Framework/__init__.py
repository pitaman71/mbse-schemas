"""Schemas framework. See Framework.md for the design."""

from . import Plain, Proxies, Reachable, Schemas, Validators, Visitors

__all__ = ["Schemas", "Visitors", "Proxies", "Reachable", "Validators", "Plain", "JSON"]


class JSON:
    """JSON serialization: `JSON.ToJSON` and `JSON.FromJSON`."""
