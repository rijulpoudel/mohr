from datetime import date
from decimal import Decimal

from cryptography.fernet import Fernet
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models.deletion import RestrictedError
from django.test import SimpleTestCase, TestCase
from django.utils import timezone

from accounts.models import Account, AccountType
from budgets.models import MonthlyBudget
from categories.models import Category, CategoryType
from plaid_integration.models import (
    PlaidAccountLink,
    PlaidConnection,
    PlaidConnectionStatus,
    PlaidWebhookEvent,
    TransactionsUpdateStatus,
)
from plaid_integration.token_encryption import (
    DecryptedToken,
    ReplacementPackage,
    TokenCryptoError,
    TokenKeyRing,
)
from transactions.models import Transaction, TransactionType


def constraint_name_of(integrity_error):
    """Return the database constraint name behind a Django IntegrityError, or
    None when the backend does not expose one."""
    cause = integrity_error.__cause__
    if cause is None:
        return None
    return getattr(getattr(cause, "diag", None), "constraint_name", None)


def assert_constraint_violation(test_case, operation, constraint_name):
    with test_case.assertRaises(IntegrityError) as raised:
        with transaction.atomic():
            operation()
    reported_name = constraint_name_of(raised.exception)
    if reported_name is not None:
        test_case.assertEqual(reported_name, constraint_name)


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


class PlaidConnectionModelTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="plaid-connection-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="plaid-connection-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id="item-sandbox-00001",
            institution_name="First Test Bank",
        )

    def create_connection(self, **overrides):
        values = {
            "user": self.user,
            "item_id": "item-sandbox-00002",
            "institution_name": "Second Test Bank",
        }
        values.update(overrides)
        return PlaidConnection.objects.create(**values)

    def test_defaults(self):
        connection = self.create_connection()

        self.assertEqual(connection.status, PlaidConnectionStatus.ACTIVE)
        self.assertFalse(connection.sync_due)
        self.assertIsNone(connection.sync_cursor)
        self.assertIsNone(connection.transactions_update_status)
        self.assertIsNone(connection.last_synced_at)
        self.assertEqual(connection.last_sync_error, "")
        self.assertIsNone(connection.access_token_encrypted)
        self.assertIsNone(connection.encryption_key_id)

    def test_timestamps_track_creation_and_updates(self):
        connection = self.create_connection()
        created_at = connection.created_at

        self.assertIsNotNone(created_at)
        self.assertIsNotNone(connection.updated_at)
        self.assertGreaterEqual(connection.updated_at, created_at)

        connection.institution_name = "Renamed Bank"
        connection.save()
        connection.refresh_from_db()

        self.assertEqual(connection.created_at, created_at)
        self.assertGreater(connection.updated_at, created_at)

    def test_item_id_is_globally_unique_across_users(self):
        assert_constraint_violation(
            self,
            lambda: PlaidConnection.objects.create(
                user=self.other_user,
                item_id=self.connection.item_id,
                institution_name="Duplicate Item",
            ),
            "plaid_connection_item_id_unique",
        )

        self.assertEqual(PlaidConnection.objects.count(), 1)
        self.assertFalse(self.other_user.plaid_connections.exists())

    def test_status_check_rejects_invalid_status(self):
        assert_constraint_violation(
            self,
            lambda: self.create_connection(status="broken"),
            "plaid_connection_status_valid",
        )

        self.assertFalse(
            PlaidConnection.objects.filter(item_id="item-sandbox-00002").exists()
        )

    def test_each_valid_status_persists(self):
        for status in PlaidConnectionStatus.values:
            with self.subTest(status=status):
                connection = self.create_connection(
                    item_id=f"item-sandbox-status-{status}", status=status
                )
                connection.refresh_from_db()

                self.assertEqual(connection.status, status)

    def test_transactions_update_status_accepts_null_and_each_valid_value(self):
        for update_status in (None, *TransactionsUpdateStatus.values):
            with self.subTest(update_status=update_status):
                connection = self.create_connection(
                    item_id=f"item-sandbox-update-{update_status}",
                    transactions_update_status=update_status,
                )
                connection.refresh_from_db()

                self.assertEqual(connection.transactions_update_status, update_status)

    def test_transactions_update_status_check_rejects_invalid_value(self):
        assert_constraint_violation(
            self,
            lambda: self.create_connection(
                transactions_update_status="complete_forever",
            ),
            "plaid_connection_transactions_update_status_valid",
        )

        self.assertFalse(
            PlaidConnection.objects.filter(item_id="item-sandbox-00002").exists()
        )

    def test_encryption_key_id_is_indexed(self):
        index_names = {index.name for index in PlaidConnection._meta.indexes}

        self.assertIn("plaid_conn_key_id_idx", index_names)

    def test_str_and_repr_never_include_token_package(self):
        connection = self.create_connection(
            access_token_encrypted="key-a:super-secret-token-package",
            encryption_key_id="key-a",
        )

        self.assertNotIn("super-secret-token-package", str(connection))
        self.assertNotIn("super-secret-token-package", repr(connection))
        self.assertNotIn(connection.access_token_encrypted, str(connection))
        self.assertNotIn(connection.access_token_encrypted, repr(connection))


class PlaidAccountLinkModelTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="plaid-link-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="plaid-link-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id="item-sandbox-link-00001",
            institution_name="Link Test Bank",
        )
        cls.other_connection = PlaidConnection.objects.create(
            user=cls.other_user,
            item_id="item-sandbox-link-00002",
            institution_name="Other Link Bank",
        )
        cls.account = Account.objects.create(
            user=cls.user,
            name="Linked Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        cls.second_account = Account.objects.create(
            user=cls.user,
            name="Linked Savings",
            account_type=AccountType.SAVINGS,
            opening_balance=Decimal("0.00"),
        )
        cls.other_account = Account.objects.create(
            user=cls.other_user,
            name="Their Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )

    def create_link(self, **overrides):
        values = {
            "connection": self.connection,
            "user": self.user,
            "account": self.account,
            "plaid_account_id": "plaid-account-00001",
            "plaid_type": "depository",
            "plaid_subtype": "checking",
            "mask": "4321",
        }
        values.update(overrides)
        return PlaidAccountLink.objects.create(**values)

    def test_link_persists_provider_identity_and_mask(self):
        link = self.create_link()

        link.refresh_from_db()

        self.assertEqual(link.connection, self.connection)
        self.assertEqual(link.user, self.user)
        self.assertEqual(link.account, self.account)
        self.assertEqual(link.plaid_account_id, "plaid-account-00001")
        self.assertEqual(link.plaid_type, "depository")
        self.assertEqual(link.plaid_subtype, "checking")
        self.assertEqual(link.mask, "4321")

    def test_balances_persist_exact_decimal_and_anchor_defaults_null(self):
        link = self.create_link(
            anchor_provider_current_balance=Decimal("123456789012.34"),
            provider_current_balance=Decimal("1200.10"),
            provider_available_balance=Decimal("1100.00"),
        )

        link.refresh_from_db()

        self.assertIsInstance(link.anchor_provider_current_balance, Decimal)
        self.assertEqual(
            link.anchor_provider_current_balance, Decimal("123456789012.34")
        )
        self.assertEqual(link.provider_current_balance, Decimal("1200.10"))
        self.assertEqual(link.provider_available_balance, Decimal("1100.00"))
        self.assertIsNone(link.anchor_applied_at)

        plain = self.create_link(
            plaid_account_id="plaid-account-00002",
            account=self.second_account,
        )
        self.assertIsNone(plain.anchor_provider_current_balance)
        self.assertIsNone(plain.provider_current_balance)
        self.assertIsNone(plain.provider_available_balance)

    def test_same_connection_cannot_map_same_plaid_account_twice(self):
        self.create_link()

        assert_constraint_violation(
            self,
            lambda: self.create_link(
                plaid_account_id="plaid-account-00001",
            ),
            "plaid_account_link_connection_plaid_account_id_unique",
        )

        self.assertEqual(PlaidAccountLink.objects.count(), 1)

    def test_same_connection_can_map_different_plaid_accounts(self):
        first = self.create_link()
        second = self.create_link(
            plaid_account_id="plaid-account-00002",
            account=self.second_account,
        )

        self.assertEqual(PlaidAccountLink.objects.count(), 2)
        self.assertEqual(list(self.connection.account_links.all()), [first, second])

    def test_same_user_cannot_map_same_account_twice(self):
        self.create_link()

        assert_constraint_violation(
            self,
            lambda: self.create_link(
                plaid_account_id="plaid-account-00002",
            ),
            "plaid_account_link_user_account_unique",
        )

        self.assertEqual(PlaidAccountLink.objects.count(), 1)

    def test_full_clean_rejects_connection_owned_by_another_user(self):
        link = PlaidAccountLink(
            connection=self.other_connection,
            user=self.user,
            account=self.account,
            plaid_account_id="plaid-account-00002",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="0000",
        )

        with self.assertRaises(ValidationError) as context:
            link.full_clean()

        self.assertIn("connection", context.exception.message_dict)

    def test_full_clean_rejects_account_owned_by_another_user(self):
        link = PlaidAccountLink(
            connection=self.connection,
            user=self.user,
            account=self.other_account,
            plaid_account_id="plaid-account-00002",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="0000",
        )

        with self.assertRaises(ValidationError) as context:
            link.full_clean()

        self.assertIn("account", context.exception.message_dict)

    def test_full_clean_accepts_valid_link(self):
        link = self.create_link(plaid_account_id="plaid-account-00003")

        link.full_clean()


class PlaidWebhookEventModelTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="plaid-webhook-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="plaid-webhook-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id="item-sandbox-webhook-00001",
            institution_name="Webhook Test Bank",
        )
        cls.other_connection = PlaidConnection.objects.create(
            user=cls.other_user,
            item_id="item-sandbox-webhook-00002",
            institution_name="Other Webhook Bank",
        )

    def create_event(self, **overrides):
        values = {
            "connection": self.connection,
            "user": self.user,
            "webhook_type": "TRANSACTIONS",
            "webhook_code": "SYNC_UPDATES_AVAILABLE",
            "item_id": self.connection.item_id,
            "idempotency_key": "a" * 64,
            "received_at": timezone.now(),
        }
        values.update(overrides)
        return PlaidWebhookEvent.objects.create(**values)

    def test_event_persists_parsed_fields_only(self):
        event = self.create_event(
            initial_update_complete=True,
            historical_update_complete=True,
        )

        event.refresh_from_db()

        self.assertEqual(event.connection, self.connection)
        self.assertEqual(event.user, self.user)
        self.assertEqual(event.webhook_type, "TRANSACTIONS")
        self.assertEqual(event.webhook_code, "SYNC_UPDATES_AVAILABLE")
        self.assertEqual(event.item_id, self.connection.item_id)
        self.assertTrue(event.initial_update_complete)
        self.assertTrue(event.historical_update_complete)
        self.assertIsNone(event.processed_at)
        self.assertFalse(hasattr(event, "raw_body"))
        self.assertFalse(hasattr(event, "body"))

    def test_idempotency_key_is_unique(self):
        self.create_event()

        assert_constraint_violation(
            self,
            lambda: self.create_event(),
            "plaid_webhook_event_idempotency_key_unique",
        )

        self.assertEqual(PlaidWebhookEvent.objects.count(), 1)

    def test_connection_and_user_both_null_is_allowed_for_quarantine(self):
        event = self.create_event(
            connection=None,
            user=None,
            item_id="item-sandbox-unknown-00001",
            idempotency_key="b" * 64,
        )

        event.refresh_from_db()

        self.assertIsNone(event.connection)
        self.assertIsNone(event.user)

    def test_connection_without_user_is_rejected(self):
        assert_constraint_violation(
            self,
            lambda: self.create_event(
                user=None,
                idempotency_key="c" * 64,
            ),
            "plaid_webhook_event_connection_user_null_pair",
        )

        self.assertFalse(
            PlaidWebhookEvent.objects.filter(idempotency_key="c" * 64).exists()
        )

    def test_user_without_connection_is_rejected(self):
        assert_constraint_violation(
            self,
            lambda: self.create_event(
                connection=None,
                item_id="item-sandbox-unknown-00002",
                idempotency_key="d" * 64,
            ),
            "plaid_webhook_event_connection_user_null_pair",
        )

        self.assertFalse(
            PlaidWebhookEvent.objects.filter(idempotency_key="d" * 64).exists()
        )

    def test_full_clean_rejects_connection_owned_by_another_user(self):
        event = PlaidWebhookEvent(
            connection=self.other_connection,
            user=self.user,
            webhook_type="TRANSACTIONS",
            webhook_code="SYNC_UPDATES_AVAILABLE",
            item_id=self.other_connection.item_id,
            idempotency_key="e" * 64,
            received_at=timezone.now(),
        )

        with self.assertRaises(ValidationError) as context:
            event.full_clean()

        self.assertIn("connection", context.exception.message_dict)

    def test_full_clean_accepts_valid_event(self):
        event = self.create_event(idempotency_key="f" * 64)

        event.full_clean()


class PlaidDeletionGraphTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="plaid-deletion-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="plaid-deletion-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.account = Account.objects.create(
            user=cls.user,
            name="Graph Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        cls.category = Category.objects.create(
            user=cls.user,
            name="Graph Salary",
            category_type=CategoryType.INCOME,
        )
        cls.expense_category = Category.objects.create(
            user=cls.user,
            name="Graph Groceries",
            category_type=CategoryType.EXPENSE,
        )
        cls.budget = MonthlyBudget.objects.create(
            user=cls.user,
            category=cls.expense_category,
            month=date(2026, 9, 1),
            amount=Decimal("500.00"),
        )
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id="item-sandbox-graph-00001",
            institution_name="Graph Bank",
            access_token_encrypted="key-a:secret-graph-token",
            encryption_key_id="key-a",
        )
        cls.link = PlaidAccountLink.objects.create(
            connection=cls.connection,
            user=cls.user,
            account=cls.account,
            plaid_account_id="plaid-account-graph-00001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1111",
        )
        cls.webhook = PlaidWebhookEvent.objects.create(
            connection=cls.connection,
            user=cls.user,
            webhook_type="TRANSACTIONS",
            webhook_code="SYNC_UPDATES_AVAILABLE",
            item_id=cls.connection.item_id,
            idempotency_key="g" * 64,
            received_at=timezone.now(),
        )

    def create_synced_transaction(self, **overrides):
        values = {
            "user": self.user,
            "account": self.account,
            "category": self.category,
            "transaction_type": TransactionType.INCOME,
            "amount": Decimal("25.50"),
            "date": date(2026, 9, 1),
            "source": "plaid",
            "connection": self.connection,
            "plaid_transaction_id": "plaid-transaction-graph-00001",
        }
        values.update(overrides)
        return Transaction.objects.create(**values)

    def test_deleting_connection_is_restricted_while_synced_transaction_exists(self):
        synced = self.create_synced_transaction()

        with self.assertRaises(RestrictedError):
            self.connection.delete()

        self.assertTrue(PlaidConnection.objects.filter(pk=self.connection.pk).exists())
        self.assertTrue(PlaidAccountLink.objects.filter(pk=self.link.pk).exists())
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=self.webhook.pk).exists())
        self.assertTrue(Transaction.objects.filter(pk=synced.pk).exists())

    def test_deleting_account_is_restricted_while_link_exists(self):
        with self.assertRaises(RestrictedError):
            self.account.delete()

        self.assertTrue(Account.objects.filter(pk=self.account.pk).exists())
        self.assertTrue(PlaidAccountLink.objects.filter(pk=self.link.pk).exists())

    def test_deleting_transaction_leaves_connection_account_and_user_intact(self):
        synced = self.create_synced_transaction()

        synced.delete()

        self.assertFalse(Transaction.objects.filter(pk=synced.pk).exists())
        self.assertTrue(PlaidConnection.objects.filter(pk=self.connection.pk).exists())
        self.assertTrue(Account.objects.filter(pk=self.account.pk).exists())
        self.assertTrue(get_user_model().objects.filter(pk=self.user.pk).exists())

    def test_deleting_user_cascades_full_owned_graph_and_preserves_other_user(self):
        other_account = Account.objects.create(
            user=self.other_user,
            name="Other Graph Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("50.00"),
        )
        other_connection = PlaidConnection.objects.create(
            user=self.other_user,
            item_id="item-sandbox-graph-00002",
            institution_name="Other Graph Bank",
        )
        other_link = PlaidAccountLink.objects.create(
            connection=other_connection,
            user=self.other_user,
            account=other_account,
            plaid_account_id="plaid-account-graph-00002",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="2222",
        )
        other_webhook = PlaidWebhookEvent.objects.create(
            connection=other_connection,
            user=self.other_user,
            webhook_type="TRANSACTIONS",
            webhook_code="SYNC_UPDATES_AVAILABLE",
            item_id=other_connection.item_id,
            idempotency_key="h" * 64,
            received_at=timezone.now(),
        )
        other_category = Category.objects.create(
            user=self.other_user,
            name="Other Graph Salary",
            category_type=CategoryType.INCOME,
        )
        other_synced = Transaction.objects.create(
            user=self.other_user,
            account=other_account,
            category=other_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("10.00"),
            date=date(2026, 9, 2),
            source="plaid",
            connection=other_connection,
            plaid_transaction_id="plaid-transaction-graph-00002",
        )
        self.create_synced_transaction()
        superseding = self.create_synced_transaction(
            plaid_transaction_id="plaid-transaction-graph-superseding",
        )
        self.create_synced_transaction(
            plaid_transaction_id="plaid-transaction-graph-pending",
            plaid_pending_transaction_id="plaid-transaction-graph-raw-pending",
            is_pending=True,
            is_superseded=True,
            superseded_by=superseding,
        )
        other_expense_category = Category.objects.create(
            user=self.other_user,
            name="Other Graph Groceries",
            category_type=CategoryType.EXPENSE,
        )
        other_budget = MonthlyBudget.objects.create(
            user=self.other_user,
            category=other_expense_category,
            month=date(2026, 9, 1),
            amount=Decimal("300.00"),
        )

        self.user.delete()

        self.assertFalse(Transaction.objects.filter(user_id=self.user.pk).exists())
        self.assertFalse(PlaidAccountLink.objects.filter(user_id=self.user.pk).exists())
        self.assertFalse(
            PlaidWebhookEvent.objects.filter(user_id=self.user.pk).exists()
        )
        self.assertFalse(PlaidConnection.objects.filter(user_id=self.user.pk).exists())
        self.assertFalse(Account.objects.filter(user_id=self.user.pk).exists())
        self.assertFalse(Category.objects.filter(user_id=self.user.pk).exists())
        self.assertFalse(MonthlyBudget.objects.filter(user_id=self.user.pk).exists())
        self.assertFalse(get_user_model().objects.filter(pk=self.user.pk).exists())

        self.assertTrue(PlaidConnection.objects.filter(pk=other_connection.pk).exists())
        self.assertTrue(PlaidAccountLink.objects.filter(pk=other_link.pk).exists())
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=other_webhook.pk).exists())
        self.assertTrue(Transaction.objects.filter(pk=other_synced.pk).exists())
        self.assertTrue(Account.objects.filter(pk=other_account.pk).exists())
        self.assertTrue(Category.objects.filter(pk=other_category.pk).exists())
        self.assertTrue(MonthlyBudget.objects.filter(pk=other_budget.pk).exists())
