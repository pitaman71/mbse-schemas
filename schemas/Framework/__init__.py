"""Schemas framework. See Framework.md for the design."""

from . import Visitors

__all__ = ["Schemas", "Visitors", "Proxies", "Plain", "JSON"]


class Schemas:
    """Schema elements: `Schemas.OfX.Data`, `Schemas.OfX.Builder`, `Schemas.OfX.Schema`."""


class Proxies:
    """Dynamic implementation: `Proxies.register(name, schema)` and `Proxies.Builders.<Name>`."""


class Plain:
    """Plain-data conversion: `Plain.ToPlain` and `Plain.FromPlain`."""


class JSON:
    """JSON serialization: `JSON.ToJSON` and `JSON.FromJSON`."""
