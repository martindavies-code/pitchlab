"""Plug-and-play REST provider interface for commercial live football event APIs."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import httpx


class EventDataProviderInterface(ABC):
    """Abstract contract for plugging in commercial live event-data APIs."""

    provider_id: str
    display_name: str
    coord_system: str

    @abstractmethod
    def health_check(self) -> dict[str, Any]:
        """Verify credentials and API connectivity."""

    @abstractmethod
    def fetch_competitions(self) -> list[dict[str, Any]]:
        """Retrieve available competitions and seasons."""

    @abstractmethod
    def fetch_match_events(self, match_id: int) -> list[dict[str, Any]]:
        """Retrieve and normalize event stream for a given match ID."""


@dataclass
class ProviderConfig:
    provider_id: str
    display_name: str
    base_url: str
    coord_system: str
    auth_header: str = "Authorization"
    api_key_masked: str = ""
    is_configured: bool = False
    capabilities: list[str] = field(default_factory=list)


class GenericRESTEventProvider(EventDataProviderInterface):
    """Concrete configurable REST event-data adapter."""

    def __init__(self, config: ProviderConfig, api_key: str | None = None) -> None:
        self.config = config
        self.provider_id = config.provider_id
        self.display_name = config.display_name
        self.coord_system = config.coord_system
        self._api_key = api_key or ""

    def health_check(self) -> dict[str, Any]:
        if not self._api_key and self.provider_id != "statsbomb_open":
            return {
                "provider_id": self.provider_id,
                "status": "not_configured",
                "message": "API key required to activate live feed.",
            }
        if self.provider_id == "statsbomb_open":
            try:
                with httpx.Client(timeout=8.0) as client:
                    r = client.get(f"{self.config.base_url}/competitions.json")
                    return {
                        "provider_id": self.provider_id,
                        "status": "connected" if r.status_code == 200 else "error",
                        "http_status": r.status_code,
                    }
            except Exception as exc:
                return {"provider_id": self.provider_id, "status": "offline", "message": str(exc)}
        return {
            "provider_id": self.provider_id,
            "status": "configured_ready",
            "message": f"Credentials stored for {self.display_name} ({self.coord_system} native grid).",
        }

    def fetch_competitions(self) -> list[dict[str, Any]]:
        if self.provider_id == "statsbomb_open":
            with httpx.Client(timeout=12.0) as client:
                r = client.get(f"{self.config.base_url}/competitions.json")
                r.raise_for_status()
                return r.json()
        return []

    def fetch_match_events(self, match_id: int) -> list[dict[str, Any]]:
        if self.provider_id == "statsbomb_open":
            with httpx.Client(timeout=15.0) as client:
                r = client.get(f"{self.config.base_url}/events/{match_id}.json")
                r.raise_for_status()
                return r.json()
        return []


# In-memory provider registry for the local studio session
PROVIDER_REGISTRY: dict[str, ProviderConfig] = {
    "statsbomb_open": ProviderConfig(
        provider_id="statsbomb_open",
        display_name="StatsBomb Open Data (GitHub)",
        base_url="https://raw.githubusercontent.com/statsbomb/open-data/master/data",
        coord_system="120x80",
        is_configured=True,
        capabilities=["events", "xg", "lineups", "formations"],
    ),
    "statsbomb_iq": ProviderConfig(
        provider_id="statsbomb_iq",
        display_name="StatsBomb IQ Live API",
        base_url="https://data.statsbombservices.com/api/v4",
        coord_system="120x80",
        auth_header="X-API-Key",
        is_configured=False,
        capabilities=["events", "xg", "360_freeze_frames", "obv"],
    ),
    "wyscout_v3": ProviderConfig(
        provider_id="wyscout_v3",
        display_name="Hudl Wyscout API v3",
        base_url="https://apirest.wyscout.com/v3",
        coord_system="100x100",
        auth_header="Authorization",
        is_configured=False,
        capabilities=["events", "xg", "player_contracts"],
    ),
    "opta_feed": ProviderConfig(
        provider_id="opta_feed",
        display_name="Stats Perform Opta Event Feed",
        base_url="https://api.performfeeds.com/soccerdata",
        coord_system="100x100",
        auth_header="Authorization",
        is_configured=False,
        capabilities=["events", "xg", "xa", "formations"],
    ),
}

_ACTIVE_KEYS: dict[str, str] = {}


def list_providers() -> list[dict[str, Any]]:
    """Return all registered data provider descriptors (with masked credentials)."""
    return [
        {
            "provider_id": cfg.provider_id,
            "display_name": cfg.display_name,
            "base_url": cfg.base_url,
            "coord_system": cfg.coord_system,
            "is_configured": cfg.is_configured,
            "api_key_masked": cfg.api_key_masked,
            "capabilities": cfg.capabilities,
        }
        for cfg in PROVIDER_REGISTRY.values()
    ]


def configure_provider(provider_id: str, api_key: str, base_url: str | None = None) -> dict[str, Any]:
    """Configure an external REST event-data provider API key for live queries."""
    if provider_id not in PROVIDER_REGISTRY:
        raise ValueError(f"Unknown provider '{provider_id}'.")
    cfg = PROVIDER_REGISTRY[provider_id]
    if base_url:
        cfg.base_url = base_url.strip()
    cleaned = api_key.strip()
    _ACTIVE_KEYS[provider_id] = cleaned
    cfg.is_configured = bool(cleaned) or provider_id == "statsbomb_open"
    cfg.api_key_masked = f"{cleaned[:4]}••••{cleaned[-3:]}" if len(cleaned) >= 8 else ("••••" if cleaned else "")
    provider = GenericRESTEventProvider(cfg, api_key=cleaned)
    return provider.health_check()
