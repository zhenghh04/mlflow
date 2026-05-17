"""Stub SSO module — placeholder so the server starts when SSO is not configured."""
from __future__ import annotations

SSO_STATE_COOKIE = "mlflow_sso_state"
SSO_TOKEN_COOKIE = "mlflow_sso_token"

def load_sso_config(config_path: str) -> dict:
    return {}

def build_authorization_url(provider: dict, state: str) -> str:
    raise NotImplementedError("SSO not configured")

def exchange_code_for_token(provider: dict, code: str, state: str) -> dict:
    raise NotImplementedError("SSO not configured")

def get_user_info(provider: dict, token: dict) -> dict:
    raise NotImplementedError("SSO not configured")

def extract_username(provider: dict, user_info: dict) -> str:
    raise NotImplementedError("SSO not configured")

def extract_groups(provider: dict, user_info: dict) -> list[str]:
    return []

def issue_session_token(username: str, secret_key: str) -> str:
    raise NotImplementedError("SSO not configured")

def verify_session_token(token: str, secret_key: str) -> str | None:
    return None
