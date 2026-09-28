"""Schemas framework. See Framework.md for the design."""

from . import Proxies, Schemas, Visitors

__all__ = ["Schemas", "Visitors", "Proxies", "Plain", "JSON"]


class Plain:
    """Plain-data conversion: `Plain.ToPlain` and `Plain.FromPlain`."""


class JSON:
    """JSON serialization: `JSON.ToJSON` and `JSON.FromJSON`."""
