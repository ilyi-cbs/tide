import pytest

from tabular.settings import Settings


def _settings(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


def test_backend_must_be_chosen_explicitly():
    with pytest.raises(ValueError, match="TABULAR_BACKEND is not set"):
        _settings().require_runtime_config()


def test_names_every_missing_aicore_setting():
    with pytest.raises(
        ValueError,
        match=r"AICORE_AUTH_URL, AICORE_CLIENT_SECRET, AICORE_DEPLOYMENT_URL \(or",
    ):
        _settings(tabular_backend="aicore", aicore_client_id="id").require_runtime_config()


def test_aicore_accepts_a_deployment_url_or_api_url_plus_id():
    base = dict(
        tabular_backend="aicore",
        aicore_auth_url="https://auth",
        aicore_client_id="id",
        aicore_client_secret="s",
    )
    _settings(**base, aicore_deployment_url="https://d").require_runtime_config()
    _settings(
        **base, aicore_api_url="https://a", aicore_deployment_id="d1"
    ).require_runtime_config()
    with pytest.raises(ValueError, match="AICORE_DEPLOYMENT_URL"):
        _settings(**base, aicore_api_url="https://a").require_runtime_config()


def test_priorlabs_needs_a_key():
    with pytest.raises(ValueError, match="PRIORLABS_API_KEY"):
        _settings(tabular_backend="priorlabs").require_runtime_config()


def test_fake_is_allowed_when_chosen():
    _settings(tabular_backend="fake").require_runtime_config()


def test_model_cache_identity_binds_model_and_account_without_exposing_credentials():
    base = dict(tabular_backend="priorlabs", priorlabs_api_key="first-key")
    identity = _settings(**base).backend_cache_identity()
    assert len(identity) == 64
    assert (
        identity
        != _settings(
            tabular_backend="priorlabs", priorlabs_api_key="rotated-key"
        ).backend_cache_identity()
    )
    assert (
        identity != _settings(**base, priorlabs_model_path="other-model").backend_cache_identity()
    )
    assert identity != _settings(**base, tabular_test_chunk_rows=123).backend_cache_identity()


def test_backend_execution_settings_reach_runtime_config():
    config = _settings(
        priorlabs_api_key="key",
        priorlabs_model_path="custom-checkpoint",
        priorlabs_max_test_batch=2500,
        priorlabs_max_classes=250,
    ).priorlabs_config()
    assert (config.model_path, config.max_test_batch, config.max_classes) == (
        "custom-checkpoint",
        2500,
        250,
    )
    config = _settings(
        aicore_auth_url="https://auth",
        aicore_client_id="id",
        aicore_client_secret="secret",
        aicore_deployment_url="https://model",
        aicore_max_test_batch=1200,
        aicore_max_classes=200,
        aicore_min_call_interval_seconds=0,
    ).aicore_config()
    assert (config.max_test_batch, config.max_classes, config.min_call_interval_seconds) == (
        1200,
        200,
        0,
    )


def test_service_execution_settings_reach_limits():
    from tabular.api.deps import build_limits

    limits = build_limits(
        _settings(tabular_max_quantile_levels=150, tabular_min_call_budget_seconds=0)
    )
    assert limits.max_levels == 150
    assert limits.min_call_budget_s == 0
