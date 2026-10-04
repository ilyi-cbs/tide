from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import time
from collections.abc import Mapping
from typing import Any, cast
from uuid import UUID

from tabular.domain.capabilities import (
    FIT_OPTION_PARAMETERS,
    MODEL_OPTION_PARAMETERS,
    SDK_OPTION_INVENTORY,
)
from tabular.domain.errors import (
    ConfigurationError,
    LimitExceeded,
    MalformedUpstream,
    ModelReferenceInvalid,
)
from tabular.domain.models import ReferenceManifest, canonical_class_label

MAX_REFERENCE_CHARACTERS = 131072


def _content(manifest: Mapping[str, Any], expires_at: int) -> bytes:
    return json.dumps(
        {**manifest, "version": 1, "expires_at": expires_at},
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()


def _token_size(content: bytes) -> int:
    return 4 * ((len(content) + 2) // 3) + 65


class ReferenceCodec:
    def __init__(self, secret: str | None, ttl_seconds: int) -> None:
        if secret is None or len(secret) < 32:
            raise ConfigurationError("model references require a configured signing secret")
        if type(ttl_seconds) is not int or ttl_seconds <= 0:
            raise ConfigurationError("model references require a positive integer TTL")
        self._secret = secret.encode()
        self._ttl_seconds = ttl_seconds

    def encode(self, manifest: Mapping[str, Any]) -> tuple[str, int]:
        _validate_manifest(manifest)
        expires_at = manifest.get("expires_at", math.ceil(time.time()) + self._ttl_seconds)
        if type(expires_at) is not int or expires_at <= time.time():
            raise ModelReferenceInvalid("model reference expired before publication")
        content = _content(manifest, expires_at)
        if _token_size(content) > MAX_REFERENCE_CHARACTERS:
            raise ModelReferenceInvalid("model reference exceeds the local size limit")
        body = base64.urlsafe_b64encode(content).decode()
        signature = hmac.new(self._secret, body.encode(), hashlib.sha256).hexdigest()
        token = f"{body}.{signature}"
        return token, expires_at

    def preflight(self, manifest: Mapping[str, Any]) -> None:
        _validate_manifest(manifest)
        expiry_digits = max(20, len(str(math.ceil(time.time()) + self._ttl_seconds)) + 1)
        reserved_expiry = 10**expiry_digits - 1
        if _token_size(_content(manifest, reserved_expiry)) > MAX_REFERENCE_CHARACTERS:
            raise LimitExceeded("fitted-model reference metadata exceeds the local size limit")

    def validate_export(self, manifest: Mapping[str, Any]) -> None:
        try:
            self.encode(manifest)
        except ModelReferenceInvalid as error:
            raise MalformedUpstream(
                "provider exported an invalid or oversized model reference"
            ) from error

    def decode(
        self, token: str, *, backend_key: str, model_key: str, identity: str | None
    ) -> ReferenceManifest:
        try:
            if not isinstance(token, str) or not 0 < len(token) <= MAX_REFERENCE_CHARACTERS:
                raise ValueError("size")
            body, signature = token.rsplit(".", 1)
            expected = hmac.new(self._secret, body.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(signature, expected):
                raise ValueError("signature")
            manifest = json.loads(base64.b64decode(body, altchars=b"-_", validate=True))
            if (
                not isinstance(manifest, dict)
                or type(manifest.get("version")) is not int
                or manifest.get("version") != 1
                or manifest.get("backendKey") != backend_key
                or manifest.get("modelKey") != model_key
                or manifest.get("configuration_identity") != identity
                or isinstance(manifest.get("expires_at"), bool)
                or not isinstance(manifest.get("expires_at"), int)
                or manifest.get("expires_at", 0) <= time.time()
            ):
                raise ValueError("binding or expiry")
            _validate_manifest(manifest)
            return cast(ReferenceManifest, manifest)
        except (ValueError, TypeError, KeyError, UnicodeError) as error:
            raise ModelReferenceInvalid(
                "invalid, expired or differently bound model reference"
            ) from error


def _validate_manifest(manifest: Mapping[str, Any]) -> None:
    try:
        required = {
            "backendKey",
            "modelKey",
            "configuration_identity",
            "task",
            "columns",
            "feature_indices",
            "record",
            "training_fingerprint",
            "model_options",
            "fit_options",
        }
        if (
            not isinstance(manifest, dict)
            or not required <= manifest.keys()
            or manifest.keys() - required - {"version", "expires_at"}
        ):
            raise ValueError("manifest fields")
        if manifest["task"] not in ("classification", "regression"):
            raise ValueError("task")
        if any(
            not isinstance(manifest[key], str) or not manifest[key]
            for key in ("backendKey", "modelKey", "configuration_identity")
        ):
            raise ValueError("binding")
        fingerprint = manifest["training_fingerprint"]
        if (
            not isinstance(fingerprint, str)
            or len(fingerprint) != 64
            or any(character not in "0123456789abcdef" for character in fingerprint)
        ):
            raise ValueError("training identity")
        columns = manifest["columns"]
        if not isinstance(columns, list) or not columns:
            raise ValueError("columns")
        names = []
        for column in columns:
            if (
                not isinstance(column, dict)
                or set(column) != {"name", "kind"}
                or not isinstance(column["name"], str)
                or not column["name"]
                or column["kind"] not in ("numeric", "categorical", "text")
            ):
                raise ValueError("schema")
            names.append(column["name"])
        indices = manifest["feature_indices"]
        if (
            len(set(names)) != len(names)
            or not isinstance(indices, list)
            or any(type(index) is not int for index in indices)
            or indices != list(range(len(columns)))
        ):
            raise ValueError("feature indices")
        record = manifest["record"]
        fields = {"tabpfn_client_version", "task", "model_id", "params", "n_train_rows", "classes"}
        if (
            not isinstance(record, dict)
            or set(record) != fields
            or record["task"] != manifest["task"]
            or record["tabpfn_client_version"] != "0.6.0"
        ):
            raise ValueError("record fields")
        UUID(record["model_id"])
        if type(record["n_train_rows"]) is not int or record["n_train_rows"] <= 0:
            raise ValueError("training dimensions")
        classes = record["classes"]
        if manifest["task"] == "classification":
            if (
                not isinstance(classes, list)
                or len(classes) < 2
                or any(not isinstance(label, str | int | float | bool) for label in classes)
                or any(isinstance(label, float) and not math.isfinite(label) for label in classes)
                or len({canonical_class_label(label) for label in classes}) != len(classes)
            ):
                raise ValueError("classes")
        elif classes is not None:
            raise ValueError("regression classes")
        params = record["params"]
        allowed = set(SDK_OPTION_INVENTORY) - {"client_options"}
        if not isinstance(params, dict) or params.keys() - allowed:
            raise ValueError("record parameters")
        for key in ("model_options", "fit_options"):
            if not isinstance(manifest[key], dict):
                raise ValueError("options")
        if manifest["model_options"].keys() - set(MODEL_OPTION_PARAMETERS) or manifest[
            "fit_options"
        ].keys() - set(FIT_OPTION_PARAMETERS):
            raise ValueError("unknown options")
        for options in (params, manifest["model_options"], manifest["fit_options"]):
            if any(
                key in options
                for key in ("client_options", "headers", "api_key", "x_train", "y_train")
            ):
                raise ValueError("unsafe options")
        config = params.get("inference_config")
        if config is not None and (
            not isinstance(config, dict) or config.keys() - {"SUBSAMPLE_SAMPLES"}
        ):
            raise ValueError("inference config")
        json.dumps(manifest, allow_nan=False)
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        raise ModelReferenceInvalid("invalid or unsafe fitted-model manifest") from error
