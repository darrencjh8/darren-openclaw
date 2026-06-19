"""Dashboard auth base — minimal stub for the deployment repo.

The full base module lives in the hermes-agent distribution.
This stub provides the Session dataclass and abstract provider protocol
so the session store and encryption modules can import without errors.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Session:
    """A verified identity. Returned by complete_login and verify_session."""
    user_id: str = ""
    email: str = ""
    display_name: str = ""
    org_id: str = ""
    provider: str = ""
    expires_at: int = 0
    access_token: str = ""
    refresh_token: str = ""


class ProviderError(Exception):
    """IDP unreachable, network error, or other transient failure."""


class RefreshExpiredError(Exception):
    """The refresh token is dead."""


class DashboardAuthProvider(ABC):
    """Protocol every dashboard-auth provider plugin implements."""
    name: str = ""
    display_name: str = ""
    supports_password: bool = False

    @abstractmethod
    def start_login(self, *, redirect_uri: str): ...

    @abstractmethod
    def complete_login(self, *, code: str, state: str, code_verifier: str, redirect_uri: str) -> Session: ...

    @abstractmethod
    def verify_session(self, *, access_token: str) -> Optional[Session]: ...

    @abstractmethod
    def refresh_session(self, *, refresh_token: str) -> Session: ...

    @abstractmethod
    def revoke_session(self, *, refresh_token: str) -> None: ...
