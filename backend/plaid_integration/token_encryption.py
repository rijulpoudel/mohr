"""Fernet key-ring token encryption with stable key ids and rotation.

Implements the ``docs/plaid.md`` section 4 contract:

- An ordered ring of ``(key_id, Fernet key)`` pairs; the first entry is the
  primary key used for all new encryption.
- ``key_id`` values are opaque configured labels, never list positions and
  never derived from key material.
- Ciphertext packages are ``key_id + ":" + fernet_token``. The key id is
  also returned separately so callers can persist it in an indexed column.
- Decryption resolves the stored key id to exactly one key first. Only when
  that id is unresolvable (for example a superseded key already removed
  from the ring) does it fall back to
  ``cryptography.fernet.MultiFernet`` trial decryption across the ring in
  order. A resolved key that fails to decrypt never falls back.
- A decrypt that succeeded with a non-primary key returns an atomic
  replacement: a complete primary-encrypted package paired with the primary
  key id. The helper, never the caller, builds the replacement, and the
  caller persists the pair together or not at all. The unresolved-key-id
  fallback always returns the replacement too; it never exposes which
  configured key actually decrypted the package.
- Every failure raises :class:`TokenCryptoError` with a message that never
  contains key material, ciphertext, plaintext, or key ids.
"""

import re
from dataclasses import dataclass, field
from typing import Sequence

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from django.core.exceptions import ImproperlyConfigured

_SAFE_KEY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_PACKAGE_SEPARATOR = ":"

_MALFORMED_MESSAGE = "Token package is malformed."
_MISMATCH_MESSAGE = "Token package key id does not match the stored key id."
_UNDECRYPTABLE_MESSAGE = "Token could not be decrypted."


class TokenCryptoError(Exception):
    """A token could not be encrypted or decrypted.

    The message never contains key material, ciphertext, plaintext, or
    key ids.
    """


@dataclass(frozen=True)
class ReplacementPackage:
    """A complete primary-encrypted replacement and the key id that matches it.

    ``package`` and ``key_id`` are one atomic pair: the package is already
    encrypted under the primary key, so persisting only the key id while
    keeping old ciphertext would corrupt the token. The package is excluded
    from ``repr`` so ciphertext never reaches logs or error traces; the key
    id may stay visible.
    """

    package: str = field(repr=False)
    key_id: str


@dataclass(frozen=True)
class DecryptedToken:
    """A decrypted token and the atomic rotation pair to persist.

    ``plaintext`` is the decrypted token, excluded from ``repr``.

    ``key_id`` is the key id the token was packaged and stored under, in
    every case. When that id resolves in the ring, it is also the key that
    decrypted the token. When it does not resolve (the ``MultiFernet``
    fallback), the key that actually decrypted the token is intentionally
    not exposed: the caller persists ``replacement``, the complete
    primary-encrypted pair, which is authoritative for the next state.

    ``replacement`` is the atomic primary-encrypted pair the caller must
    persist together, or ``None`` when the token was already decrypted with
    the primary key.
    """

    plaintext: bytes = field(repr=False)
    key_id: str
    replacement: ReplacementPackage | None = None


class TokenKeyRing:
    """An ordered Fernet key ring keyed by opaque configured key ids."""

    def __init__(self, entries: Sequence[tuple[str, str]]):
        if not entries:
            raise ImproperlyConfigured("The token key ring must not be empty.")
        key_ids = [key_id for key_id, _ in entries]
        if len(key_ids) != len(set(key_ids)):
            raise ImproperlyConfigured("The token key ring contains duplicate key ids.")
        self._fernets: dict[str, Fernet] = {}
        for key_id, key in entries:
            if not _SAFE_KEY_ID_RE.fullmatch(key_id):
                raise ImproperlyConfigured(
                    "The token key ring contains an unsafe key id."
                )
            try:
                self._fernets[key_id] = Fernet(key)
            except (TypeError, ValueError):
                raise ImproperlyConfigured(
                    "The token key ring contains an invalid Fernet key."
                )
        self._ordered_key_ids = list(self._fernets)
        self._multi_fernet = MultiFernet(
            [self._fernets[key_id] for key_id in self._ordered_key_ids]
        )

    @classmethod
    def from_config(cls, raw: str) -> "TokenKeyRing":
        """Strictly parse ``PLAID_TOKEN_KEYS`` into a validated key ring.

        Syntax: comma-separated ``keyid:key`` pairs, first entry primary.
        Every problem raises :class:`django.core.exceptions.ImproperlyConfigured`
        without echoing the offending value.
        """
        if not raw:
            raise ImproperlyConfigured(
                "PLAID_TOKEN_KEYS must be a non-empty token key ring."
            )
        entries: list[tuple[str, str]] = []
        for entry in raw.split(","):
            key_id, separator, key = entry.partition(_PACKAGE_SEPARATOR)
            if not separator:
                raise ImproperlyConfigured(
                    "PLAID_TOKEN_KEYS entries must pair a key id and a Fernet key."
                )
            if not key_id:
                raise ImproperlyConfigured("PLAID_TOKEN_KEYS contains an empty key id.")
            if not key:
                raise ImproperlyConfigured(
                    "PLAID_TOKEN_KEYS contains an empty Fernet key."
                )
            if not _SAFE_KEY_ID_RE.fullmatch(key_id):
                raise ImproperlyConfigured(
                    "PLAID_TOKEN_KEYS contains an unsafe key id."
                )
            try:
                Fernet(key)
            except (TypeError, ValueError):
                raise ImproperlyConfigured(
                    "PLAID_TOKEN_KEYS contains an invalid Fernet key."
                )
            entries.append((key_id, key))
        return cls(entries)

    @property
    def primary_key_id(self) -> str:
        return self._ordered_key_ids[0]

    def key_ids(self) -> list[str]:
        return list(self._ordered_key_ids)

    def encrypt(self, plaintext: bytes) -> tuple[str, str]:
        """Encrypt with the primary key.

        Returns ``(package, key_id)`` where ``package`` is
        ``key_id + ":" + fernet_token`` and ``key_id`` is the separate
        metadata for the indexed model column.
        """
        primary = self._fernets[self.primary_key_id]
        token = primary.encrypt(plaintext).decode()
        package = self.primary_key_id + _PACKAGE_SEPARATOR + token
        return package, self.primary_key_id

    def decrypt(self, package: str, stored_key_id: str) -> DecryptedToken:
        embedded_id, separator, ciphertext = package.partition(_PACKAGE_SEPARATOR)
        if (
            not separator
            or not _SAFE_KEY_ID_RE.fullmatch(embedded_id)
            or not ciphertext
        ):
            raise TokenCryptoError(_MALFORMED_MESSAGE)
        if embedded_id != stored_key_id:
            raise TokenCryptoError(_MISMATCH_MESSAGE)
        token = ciphertext.encode()
        if stored_key_id in self._fernets:
            fernet = self._fernets[stored_key_id]
            try:
                plaintext = fernet.decrypt(token)
            except InvalidToken:
                raise TokenCryptoError(_UNDECRYPTABLE_MESSAGE)
            return self._result(plaintext, stored_key_id)
        try:
            plaintext = self._multi_fernet.decrypt(token)
        except InvalidToken:
            raise TokenCryptoError(_UNDECRYPTABLE_MESSAGE)
        replacement_package, replacement_key_id = self.encrypt(plaintext)
        return DecryptedToken(
            plaintext,
            stored_key_id,
            ReplacementPackage(replacement_package, replacement_key_id),
        )

    def _result(self, plaintext: bytes, key_id: str) -> DecryptedToken:
        if key_id == self.primary_key_id:
            return DecryptedToken(plaintext, key_id)
        replacement_package, replacement_key_id = self.encrypt(plaintext)
        return DecryptedToken(
            plaintext,
            key_id,
            ReplacementPackage(replacement_package, replacement_key_id),
        )

    def __repr__(self) -> str:
        return f"TokenKeyRing(key_ids={self._ordered_key_ids!r})"
