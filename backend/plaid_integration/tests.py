from cryptography.fernet import Fernet
from django.test import SimpleTestCase

from plaid_integration.token_encryption import (
    DecryptedToken,
    ReplacementPackage,
    TokenCryptoError,
    TokenKeyRing,
)

PLAINTEXT = b"access-sandbox-00000000-0000-0000-0000-000000000000"

KEY_A = Fernet.generate_key().decode()
KEY_B = Fernet.generate_key().decode()

MALFORMED_MESSAGE = "Token package is malformed."
MISMATCH_MESSAGE = "Token package key id does not match the stored key id."
UNDECRYPTABLE_MESSAGE = "Token could not be decrypted."


def ring_two_keys():
    return TokenKeyRing([("key-a", KEY_A), ("key-b", KEY_B)])


def ciphertext_of(package):
    return package.split(":", 1)[1]


def assert_primary_replacement(test_case, ring, replacement):
    test_case.assertIsInstance(replacement, ReplacementPackage)
    test_case.assertEqual(replacement.key_id, ring.primary_key_id)
    test_case.assertTrue(replacement.package.startswith(replacement.key_id + ":"))
    replacement_token = ring.decrypt(replacement.package, replacement.key_id)
    test_case.assertEqual(replacement_token.plaintext, PLAINTEXT)


class TokenEncryptionTests(SimpleTestCase):
    def test_encrypt_returns_package_and_separate_primary_key_id(self):
        ring = ring_two_keys()

        package, key_id = ring.encrypt(PLAINTEXT)

        self.assertEqual(key_id, "key-a")
        self.assertTrue(package.startswith("key-a:"))

    def test_primary_encrypt_decrypt_round_trip(self):
        ring = ring_two_keys()

        package, key_id = ring.encrypt(PLAINTEXT)
        decrypted = ring.decrypt(package, key_id)

        self.assertIsInstance(decrypted, DecryptedToken)
        self.assertEqual(decrypted.plaintext, PLAINTEXT)
        self.assertEqual(decrypted.key_id, "key-a")
        self.assertIsNone(decrypted.replacement)

    def test_decrypted_token_repr_never_exposes_plaintext(self):
        ring = ring_two_keys()
        package, key_id = ring.encrypt(PLAINTEXT)
        decrypted = ring.decrypt(package, key_id)

        self.assertNotIn(PLAINTEXT.decode(), repr(decrypted))

    def test_decrypted_token_repr_never_exposes_replacement_ciphertext(self):
        old_primary = TokenKeyRing([("key-b", KEY_B), ("key-a", KEY_A)])
        package, key_id = old_primary.encrypt(PLAINTEXT)

        decrypted = ring_two_keys().decrypt(package, key_id)
        self.assertIsNotNone(decrypted.replacement)
        replacement = decrypted.replacement

        representation = repr(decrypted)
        self.assertNotIn(PLAINTEXT.decode(), representation)
        self.assertNotIn(replacement.package, representation)
        self.assertNotIn(ciphertext_of(replacement.package), representation)
        self.assertIn(decrypted.key_id, representation)
        self.assertIn(replacement.key_id, representation)

    def test_key_id_resolution_survives_ring_reordering(self):
        package, key_id = ring_two_keys().encrypt(PLAINTEXT)

        reordered = TokenKeyRing([("key-b", KEY_B), ("key-a", KEY_A)])
        decrypted = reordered.decrypt(package, key_id)

        self.assertEqual(decrypted.plaintext, PLAINTEXT)
        self.assertEqual(decrypted.key_id, "key-a")
        assert_primary_replacement(self, reordered, decrypted.replacement)

    def test_resolved_old_key_decrypt_returns_primary_replacement(self):
        old_primary = TokenKeyRing([("key-b", KEY_B), ("key-a", KEY_A)])
        package, key_id = old_primary.encrypt(PLAINTEXT)
        self.assertEqual(key_id, "key-b")

        current = ring_two_keys()
        decrypted = current.decrypt(package, key_id)

        self.assertEqual(decrypted.plaintext, PLAINTEXT)
        self.assertEqual(decrypted.key_id, "key-b")
        assert_primary_replacement(self, current, decrypted.replacement)

    def test_unresolvable_key_id_falls_back_and_returns_primary_replacement(self):
        retired = TokenKeyRing([("key-c", KEY_B), ("key-a", KEY_A)])
        package, key_id = retired.encrypt(PLAINTEXT)
        self.assertEqual(key_id, "key-c")

        current = ring_two_keys()
        self.assertNotIn("key-c", current.key_ids())
        decrypted = current.decrypt(package, key_id)

        self.assertEqual(decrypted.plaintext, PLAINTEXT)
        self.assertEqual(decrypted.key_id, "key-c")
        self.assertNotEqual(decrypted.key_id, current.primary_key_id)
        assert_primary_replacement(self, current, decrypted.replacement)

    def test_resolved_but_wrong_key_fails_without_ring_fallback(self):
        other_package, _ = TokenKeyRing([("key-b", KEY_B)]).encrypt(PLAINTEXT)
        other_ciphertext = ciphertext_of(other_package)
        ring = ring_two_keys()

        self.assertEqual(
            ring.decrypt("key-b:" + other_ciphertext, "key-b").plaintext,
            PLAINTEXT,
        )

        with self.assertRaises(TokenCryptoError) as raised:
            ring.decrypt("key-a:" + other_ciphertext, "key-a")

        self.assertEqual(str(raised.exception), UNDECRYPTABLE_MESSAGE)

    def test_malformed_package_without_separator_fails(self):
        with self.assertRaises(TokenCryptoError) as raised:
            ring_two_keys().decrypt("no-separator-here", "key-a")

        self.assertEqual(str(raised.exception), MALFORMED_MESSAGE)

    def test_malformed_package_with_unsafe_embedded_key_id_fails(self):
        ring = ring_two_keys()
        package, _ = TokenKeyRing([("key-a", KEY_A)]).encrypt(PLAINTEXT)

        with self.assertRaises(TokenCryptoError) as raised:
            ring.decrypt("bad id!:" + ciphertext_of(package), "key-a")

        self.assertEqual(str(raised.exception), MALFORMED_MESSAGE)

    def test_malformed_package_with_empty_ciphertext_fails(self):
        with self.assertRaises(TokenCryptoError) as raised:
            ring_two_keys().decrypt("key-a:", "key-a")

        self.assertEqual(str(raised.exception), MALFORMED_MESSAGE)

    def test_package_key_id_mismatch_with_stored_key_id_fails(self):
        old_primary = TokenKeyRing([("key-b", KEY_B), ("key-a", KEY_A)])
        package, _ = old_primary.encrypt(PLAINTEXT)

        with self.assertRaises(TokenCryptoError) as raised:
            ring_two_keys().decrypt(package, "key-a")

        self.assertEqual(str(raised.exception), MISMATCH_MESSAGE)

    def test_invalid_ciphertext_fails_generically(self):
        with self.assertRaises(TokenCryptoError) as raised:
            ring_two_keys().decrypt("key-a:not-a-fernet-token", "key-a")

        self.assertEqual(str(raised.exception), UNDECRYPTABLE_MESSAGE)

    def test_decryption_errors_never_leak_values(self):
        ring = ring_two_keys()
        package, _ = ring.encrypt(PLAINTEXT)
        mismatched, _ = TokenKeyRing([("key-b", KEY_B)]).encrypt(PLAINTEXT)
        bad_package = "bad id!:" + ciphertext_of(package)

        cases = [
            (bad_package, "key-a"),
            ("key-a:not-a-fernet-token", "key-a"),
            ("no-separator-here", "key-a"),
            (mismatched, "key-a"),
        ]
        known_messages = {MALFORMED_MESSAGE, MISMATCH_MESSAGE, UNDECRYPTABLE_MESSAGE}
        for bad_pkg, stored_id in cases:
            with self.assertRaises(TokenCryptoError) as raised:
                ring.decrypt(bad_pkg, stored_id)
            message = str(raised.exception)
            self.assertIn(message, known_messages)
            self.assertNotIn(PLAINTEXT.decode(), message)
            self.assertNotIn(KEY_A, message)
            self.assertNotIn(KEY_B, message)
            self.assertNotIn(bad_pkg, message)
            self.assertNotIn("key-a", message)
            self.assertNotIn("key-b", message)
