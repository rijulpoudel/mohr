"""Tests for the authenticated connections list and manual sync endpoints.

Covers the ``docs/plaid.md`` section 3 ``GET /api/plaid/connections/`` and
``POST /api/plaid/connections/<id>/sync/`` contracts for issue #38 slice F:
the frozen response shapes, owner-scoped lookup with indistinguishable 404,
the fixed 503 disabled-integration boundary, the 202-while-incomplete /
200-once-anchored sync mapping through an injected fake gateway (never the
network), the blocked-run 503 mapping, the bounded no-write read path, and
cross-user isolation end to end. Every database-visible behavior is asserted
against the real PostgreSQL-backed test database; no provider call is ever
made and the fake gateway is injected by patching
``PlaidGateway.from_settings`` exactly as the existing slice tests do.
"""

from datetime import date
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from accounts.models import Account, AccountType
from categories.models import Category, CategoryType
from plaid_integration.gateway import PLAID_UNAVAILABLE_DETAIL, PlaidGatewayError
from plaid_integration.models import (
    PlaidAccountLink,
    PlaidConnection,
    PlaidConnectionStatus,
    TransactionsUpdateStatus,
)
from plaid_integration.services import PAGE_CAP, SYNC_ERROR_TAG
from plaid_integration.tests_sync_page import added_tx
from plaid_integration.tests_sync_run import (
    CHECKING_ACCOUNT_ID,
    CURSOR_A,
    CURSOR_B,
    PLAID_API_SETTINGS,
    SYNTHETIC_ACCESS_TOKEN,
    FakeSyncGateway,
    _encrypt,
    checking_outcome,
    make_page,
)
from transactions.models import Transaction, TransactionSource, TransactionType


class ConnectionListAPITests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="conn-list-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="conn-list-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.checking = Account.objects.create(
            user=cls.user,
            name="List Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        cls.savings = Account.objects.create(
            user=cls.user,
            name="List Savings",
            account_type=AccountType.SAVINGS,
            opening_balance=Decimal("0.00"),
        )
        cls.other_checking = Account.objects.create(
            user=cls.other_user,
            name="Their Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id="item-sandbox-conn-list-00001",
            institution_name="List Test Bank",
            access_token_encrypted="key-a:synthetic-secret-package",
            encryption_key_id="key-a",
            sync_cursor="cursor-opaque-stored",
            transactions_update_status=TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE,
            last_synced_at=timezone.now(),
            last_sync_error="transaction-sync: synthetic redacted reason",
        )
        cls.completed_connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id="item-sandbox-conn-list-00002",
            institution_name="Completed Bank",
            transactions_update_status=TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
            last_synced_at=timezone.now(),
        )
        cls.other_connection = PlaidConnection.objects.create(
            user=cls.other_user,
            item_id="item-sandbox-conn-list-00003",
            institution_name="Other Bank",
            access_token_encrypted="key-a:other-secret-package",
            encryption_key_id="key-a",
            sync_cursor="cursor-opaque-other",
            transactions_update_status=TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
        )
        cls.link = PlaidAccountLink.objects.create(
            connection=cls.connection,
            user=cls.user,
            account=cls.checking,
            plaid_account_id="plaid-account-conn-list-0001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1234",
        )
        cls.anchored_link = PlaidAccountLink.objects.create(
            connection=cls.connection,
            user=cls.user,
            account=cls.savings,
            plaid_account_id="plaid-account-conn-list-0002",
            plaid_type="depository",
            plaid_subtype="savings",
            mask="5678",
            anchor_provider_current_balance=Decimal("500.00"),
            anchor_applied_at=timezone.now(),
        )
        cls.other_link = PlaidAccountLink.objects.create(
            connection=cls.other_connection,
            user=cls.other_user,
            account=cls.other_checking,
            plaid_account_id="plaid-account-conn-list-0003",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="9999",
            anchor_applied_at=timezone.now(),
        )

    def list_url(self):
        return reverse("plaid-connections")

    def snapshot_rows(self):
        return {
            "connections": list(PlaidConnection.objects.order_by("pk").values()),
            "links": list(PlaidAccountLink.objects.order_by("pk").values()),
        }

    def test_unauthenticated_get_returns_401_without_provider_call(self):
        with patch(
            "plaid_integration.gateway.PlaidGateway.from_settings"
        ) as from_settings:
            response = self.client.get(self.list_url())

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )
        from_settings.assert_not_called()

    def test_get_returns_only_own_connections_with_exact_field_set(self):
        self.client.force_login(self.user)

        response = self.client.get(self.list_url())

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIsInstance(response.data, list)
        self.assertEqual(len(response.data), 2)
        by_id = {item["id"]: item for item in response.data}
        self.assertEqual(set(by_id), {self.connection.pk, self.completed_connection.pk})
        self.assertNotIn(self.other_connection.pk, by_id)
        for item in response.data:
            self.assertEqual(
                set(item.keys()),
                {
                    "id",
                    "institution_name",
                    "status",
                    "sync_pending",
                    "last_synced_at",
                    "linked_accounts",
                },
            )
        mid = by_id[self.connection.pk]
        self.assertEqual(mid["institution_name"], "List Test Bank")
        self.assertEqual(mid["status"], PlaidConnectionStatus.ACTIVE)
        self.assertIsNotNone(mid["last_synced_at"])
        self.assertTrue(mid["sync_pending"])
        completed = by_id[self.completed_connection.pk]
        self.assertFalse(completed["sync_pending"])
        self.assertEqual(completed["linked_accounts"], [])

    def test_linked_accounts_carry_exact_field_set_and_sync_pending(self):
        self.client.force_login(self.user)

        response = self.client.get(self.list_url())

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        by_id = {item["id"]: item for item in response.data}
        accounts = by_id[self.connection.pk]["linked_accounts"]
        self.assertEqual(len(accounts), 2)
        accounts_by_id = {account["id"]: account for account in accounts}
        # ``id`` is the linked Mohr account id, so the list cross-references
        # /api/accounts/ without another lookup; the internal link id is not
        # exposed.
        self.assertEqual(
            set(accounts_by_id),
            {self.link.account_id, self.anchored_link.account_id},
        )
        for account in accounts:
            self.assertEqual(
                set(account.keys()),
                {"id", "name", "account_type", "mask", "sync_pending"},
            )
        unanchored = accounts_by_id[self.link.account_id]
        self.assertEqual(unanchored["name"], "List Checking")
        self.assertEqual(unanchored["account_type"], AccountType.CHECKING)
        self.assertEqual(unanchored["mask"], "1234")
        self.assertTrue(unanchored["sync_pending"])
        anchored = accounts_by_id[self.anchored_link.account_id]
        self.assertEqual(anchored["name"], "List Savings")
        self.assertEqual(anchored["account_type"], AccountType.SAVINGS)
        self.assertFalse(anchored["sync_pending"])

    def test_account_sync_pending_flips_after_anchor_is_applied(self):
        self.client.force_login(self.user)
        before = self.client.get(self.list_url())
        self.assertEqual(before.status_code, status.HTTP_200_OK)
        before_accounts = {
            account["id"]: account
            for account in {item["id"]: item for item in before.data}[
                self.connection.pk
            ]["linked_accounts"]
        }
        self.assertTrue(before_accounts[self.link.account_id]["sync_pending"])

        self.link.anchor_applied_at = timezone.now()
        self.link.save(update_fields=["anchor_applied_at"])

        after = self.client.get(self.list_url())
        self.assertEqual(after.status_code, status.HTTP_200_OK)
        after_accounts = {
            account["id"]: account
            for account in {item["id"]: item for item in after.data}[
                self.connection.pk
            ]["linked_accounts"]
        }
        self.assertFalse(after_accounts[self.link.account_id]["sync_pending"])

    def test_get_performs_no_provider_call_no_write_and_bounded_queries(self):
        self.client.force_login(self.user)
        before = self.snapshot_rows()

        with (
            patch(
                "plaid_integration.gateway.PlaidGateway.from_settings"
            ) as from_settings,
            self.assertNumQueries(5),
        ):
            response = self.client.get(self.list_url())

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        from_settings.assert_not_called()
        self.assertEqual(self.snapshot_rows(), before)

    def test_get_never_exposes_stored_secrets_cursors_or_provider_payloads(self):
        self.client.force_login(self.user)

        response = self.client.get(self.list_url())

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        raw = response.content.decode()
        for forbidden in (
            "synthetic-secret-package",
            "other-secret-package",
            "cursor-opaque-stored",
            "cursor-opaque-other",
            "item-sandbox-conn-list-00001",
            "item-sandbox-conn-list-00002",
            "item-sandbox-conn-list-00003",
            "plaid-account-conn-list-0001",
            "plaid-account-conn-list-0002",
            "plaid-account-conn-list-0003",
            "key-a",
            "synthetic redacted reason",
        ):
            self.assertNotIn(forbidden, raw)

    def test_unsupported_method_on_list_returns_405(self):
        self.client.force_login(self.user)

        response = self.client.post(self.list_url())

        self.assertEqual(response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)


@override_settings(**PLAID_API_SETTINGS)
class ConnectionSyncAPITests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="conn-sync-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="conn-sync-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.checking = Account.objects.create(
            user=cls.user,
            name="Sync Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        cls.other_account = Account.objects.create(
            user=cls.other_user,
            name="Their Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        cls.other_category = Category.objects.create(
            user=cls.other_user,
            name="Their Salary",
            category_type=CategoryType.INCOME,
        )
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id="item-sandbox-conn-sync-00001",
            institution_name="Sync Test Bank",
            access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
            encryption_key_id="key-a",
        )
        cls.link = PlaidAccountLink.objects.create(
            connection=cls.connection,
            user=cls.user,
            account=cls.checking,
            plaid_account_id=CHECKING_ACCOUNT_ID,
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1234",
        )
        cls.other_connection = PlaidConnection.objects.create(
            user=cls.other_user,
            item_id="item-sandbox-conn-sync-00002",
            institution_name="Other Sync Bank",
            access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
            encryption_key_id="key-a",
        )
        cls.other_link = PlaidAccountLink.objects.create(
            connection=cls.other_connection,
            user=cls.other_user,
            account=cls.other_account,
            plaid_account_id="plaid-account-other-sync-0001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="9999",
        )
        cls.other_transaction = Transaction.objects.create(
            user=cls.other_user,
            account=cls.other_account,
            category=cls.other_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("10.00"),
            date=date(2026, 9, 1),
            source=TransactionSource.PLAID,
            connection=cls.other_connection,
            plaid_transaction_id="plaid-tx-other-0001",
        )

    def setUp(self):
        self.csrf_client = APIClient(enforce_csrf_checks=True)
        self.csrf_client.force_login(self.user)
        csrf_response = self.csrf_client.get(reverse("auth-csrf"))
        self.csrf_token = csrf_response.cookies["csrftoken"].value

    def sync_url(self, connection_pk):
        return reverse("plaid-connection-sync", args=[connection_pk])

    def post_sync(self, connection_pk, client=None, *, csrf_token=None, **extra):
        client = client if client is not None else self.csrf_client
        return client.post(
            self.sync_url(connection_pk),
            data={},
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token if csrf_token is not None else self.csrf_token,
            **extra,
        )

    def patched_gateway(self, gateway):
        return patch(
            "plaid_integration.gateway.PlaidGateway.from_settings",
            return_value=gateway,
        )

    def snapshot_rows(self):
        return {
            "connections": list(PlaidConnection.objects.order_by("pk").values()),
            "links": list(PlaidAccountLink.objects.order_by("pk").values()),
            "accounts": list(Account.objects.order_by("pk").values()),
            "transactions": list(Transaction.objects.order_by("pk").values()),
        }

    def snapshot_other_user_rows(self):
        return {
            "connections": list(
                PlaidConnection.objects.filter(user=self.other_user)
                .order_by("pk")
                .values()
            ),
            "links": list(
                PlaidAccountLink.objects.filter(user=self.other_user)
                .order_by("pk")
                .values()
            ),
            "accounts": list(
                Account.objects.filter(user=self.other_user).order_by("pk").values()
            ),
            "transactions": list(
                Transaction.objects.filter(user=self.other_user).order_by("pk").values()
            ),
        }

    def completing_script(self):
        return [
            make_page(
                added=(
                    added_tx(
                        transaction_id="tx-1",
                        account_id=CHECKING_ACCOUNT_ID,
                        amount="12.34",
                    ),
                ),
                account_outcomes=(checking_outcome(),),
                next_cursor=CURSOR_A,
                has_more=True,
                status="INITIAL_UPDATE_COMPLETE",
            ),
            make_page(
                added=(
                    added_tx(
                        transaction_id="tx-2",
                        account_id=CHECKING_ACCOUNT_ID,
                        amount="45.00",
                        transaction_type="income",
                    ),
                ),
                account_outcomes=(),
                next_cursor=CURSOR_B,
                has_more=False,
                status="HISTORICAL_UPDATE_COMPLETE",
            ),
        ]

    def test_unauthenticated_post_returns_401_without_provider_call_or_write(self):
        before = self.snapshot_rows()
        with patch(
            "plaid_integration.gateway.PlaidGateway.from_settings"
        ) as from_settings:
            response = self.client.post(self.sync_url(self.connection.pk))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )
        from_settings.assert_not_called()
        self.assertEqual(self.snapshot_rows(), before)

    def test_missing_connection_id_returns_404_without_provider_call_or_write(self):
        before = self.snapshot_rows()
        with patch(
            "plaid_integration.gateway.PlaidGateway.from_settings"
        ) as from_settings:
            response = self.post_sync(999999)

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            response.json(),
            {"detail": "No PlaidConnection matches the given query."},
        )
        from_settings.assert_not_called()
        self.assertEqual(self.snapshot_rows(), before)

    def test_foreign_connection_id_returns_indistinguishable_404_without_write(self):
        before = self.snapshot_rows()
        with patch(
            "plaid_integration.gateway.PlaidGateway.from_settings"
        ) as from_settings:
            foreign = self.post_sync(self.other_connection.pk)
            missing = self.post_sync(999999)

        self.assertEqual(foreign.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(missing.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            foreign.json(),
            {"detail": "No PlaidConnection matches the given query."},
        )
        self.assertEqual(foreign.json(), missing.json())
        from_settings.assert_not_called()
        self.assertEqual(self.snapshot_rows(), before)

    def test_post_without_csrf_returns_403_without_provider_call_or_write(self):
        before = self.snapshot_rows()
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)
        with patch(
            "plaid_integration.gateway.PlaidGateway.from_settings"
        ) as from_settings:
            response = csrf_client.post(
                self.sync_url(self.connection.pk), data={}, format="json"
            )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        from_settings.assert_not_called()
        self.assertEqual(self.snapshot_rows(), before)

    def test_non_post_method_returns_405_without_provider_call_or_write(self):
        before = self.snapshot_rows()
        with patch(
            "plaid_integration.gateway.PlaidGateway.from_settings"
        ) as from_settings:
            response = self.csrf_client.get(
                self.sync_url(self.connection.pk),
                HTTP_X_CSRFTOKEN=self.csrf_token,
            )

        self.assertEqual(response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        from_settings.assert_not_called()
        self.assertEqual(self.snapshot_rows(), before)

    @override_settings(PLAID_ENABLED=False)
    def test_disabled_integration_returns_fixed_503_without_provider_call_or_write(
        self,
    ):
        before = self.snapshot_rows()
        with patch(
            "plaid_integration.gateway.PlaidGateway.from_settings"
        ) as from_settings:
            response = self.post_sync(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        from_settings.assert_not_called()
        self.assertEqual(self.snapshot_rows(), before)

    def test_sync_returns_202_while_history_window_is_incomplete(self):
        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-1",
                            account_id=CHECKING_ACCOUNT_ID,
                        ),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=True,
                    status="INITIAL_UPDATE_COMPLETE",
                ),
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-2",
                            account_id=CHECKING_ACCOUNT_ID,
                        ),
                    ),
                    account_outcomes=(),
                    next_cursor=CURSOR_B,
                    has_more=False,
                    status="INITIAL_UPDATE_COMPLETE",
                ),
            ]
        )

        with self.patched_gateway(gateway):
            response = self.post_sync(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_202_ACCEPTED)
        self.assertEqual(
            response.json(),
            {"connection_id": self.connection.pk, "status": "processing"},
        )
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_B)
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE,
        )
        link = PlaidAccountLink.objects.get(pk=self.link.pk)
        self.assertIsNone(link.anchor_applied_at)
        account = Account.objects.get(pk=self.checking.pk)
        self.assertEqual(account.opening_balance, Decimal("0.00"))
        self.assertEqual(
            list(
                Transaction.objects.filter(user=self.user)
                .order_by("plaid_transaction_id")
                .values_list("plaid_transaction_id", flat=True)
            ),
            ["tx-1", "tx-2"],
        )

    def test_sync_returns_200_with_frozen_field_set_once_anchor_is_applied(self):
        gateway = FakeSyncGateway(self.completing_script())

        with self.patched_gateway(gateway):
            response = self.post_sync(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        payload = response.json()
        self.assertEqual(
            set(payload.keys()),
            {"connection_id", "status", "added", "modified", "removed"},
        )
        self.assertEqual(payload["connection_id"], self.connection.pk)
        self.assertEqual(payload["status"], PlaidConnectionStatus.ACTIVE)
        self.assertEqual(payload["added"], 2)
        self.assertEqual(payload["modified"], 0)
        self.assertEqual(payload["removed"], 0)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_B)
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
        )
        self.assertEqual(self.connection.last_sync_error, "")
        link = PlaidAccountLink.objects.get(pk=self.link.pk)
        self.assertIsNotNone(link.anchor_applied_at)
        account = Account.objects.get(pk=self.checking.pk)
        self.assertEqual(account.opening_balance, Decimal("67.34"))
        self.assertEqual(Transaction.objects.filter(user=self.user).count(), 2)

    def test_blocked_run_returns_fixed_503_and_is_never_reported_successful(self):
        gateway = FakeSyncGateway([PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL)])

        with self.patched_gateway(gateway):
            response = self.post_sync(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ERROR)
        self.assertTrue(self.connection.last_sync_error.startswith(SYNC_ERROR_TAG))
        self.assertIsNone(self.connection.sync_cursor)
        self.assertEqual(Transaction.objects.filter(user=self.user).count(), 0)
        self.assertEqual(Account.objects.count(), 2)
        self.assertEqual(PlaidAccountLink.objects.count(), 2)

    def test_cross_user_rows_are_untouched_by_both_routes_end_to_end(self):
        self.client.force_login(self.user)
        get_response = self.client.get(reverse("plaid-connections"))
        self.assertEqual(get_response.status_code, status.HTTP_200_OK)
        returned_ids = {item["id"] for item in get_response.data}
        self.assertNotIn(self.other_connection.pk, returned_ids)
        before = self.snapshot_other_user_rows()

        gateway = FakeSyncGateway(self.completing_script())
        with self.patched_gateway(gateway):
            sync_response = self.post_sync(self.connection.pk)

        self.assertEqual(sync_response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            sync_response.json(),
            {
                "connection_id": self.connection.pk,
                "status": PlaidConnectionStatus.ACTIVE,
                "added": 2,
                "modified": 0,
                "removed": 0,
            },
        )
        self.assertEqual(self.snapshot_other_user_rows(), before)
        other_transaction = Transaction.objects.get(pk=self.other_transaction.pk)
        self.assertEqual(other_transaction.amount, Decimal("10.00"))

    def test_sync_returns_202_at_page_cap_then_200_on_a_later_trigger(self):
        # The page cap is the normal first-trigger outcome for a large initial
        # import, so the endpoint must report 202 and leave the cursor at the
        # last committed page, then complete on a later manual trigger.
        capped_pages = [
            make_page(
                added=(
                    added_tx(
                        transaction_id=f"cap-tx-{index}",
                        account_id=CHECKING_ACCOUNT_ID,
                        amount="1.00",
                    ),
                ),
                account_outcomes=(checking_outcome(),) if index == 0 else (),
                next_cursor=f"cursor-cap-{index}",
                has_more=True,
                status="INITIAL_UPDATE_COMPLETE",
            )
            for index in range(PAGE_CAP)
        ]

        with self.patched_gateway(FakeSyncGateway(capped_pages)):
            capped = self.post_sync(self.connection.pk)

        self.assertEqual(capped.status_code, status.HTTP_202_ACCEPTED)
        self.assertEqual(
            capped.json(),
            {"connection_id": self.connection.pk, "status": "processing"},
        )
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, f"cursor-cap-{PAGE_CAP - 1}")
        self.assertEqual(
            Transaction.objects.filter(user=self.user).count(),
            PAGE_CAP,
        )
        link = PlaidAccountLink.objects.get(pk=self.link.pk)
        self.assertIsNone(link.anchor_applied_at)
        self.assertEqual(
            Account.objects.get(pk=self.checking.pk).opening_balance,
            Decimal("0.00"),
        )

        final_page = make_page(
            added=(
                added_tx(
                    transaction_id="cap-tx-final",
                    account_id=CHECKING_ACCOUNT_ID,
                    amount="1.00",
                ),
            ),
            next_cursor=CURSOR_B,
            has_more=False,
            status="HISTORICAL_UPDATE_COMPLETE",
        )

        with self.patched_gateway(FakeSyncGateway([final_page])):
            completed = self.post_sync(self.connection.pk)

        self.assertEqual(completed.status_code, status.HTTP_200_OK)
        self.assertEqual(
            completed.json(),
            {
                "connection_id": self.connection.pk,
                "status": PlaidConnectionStatus.ACTIVE,
                "added": 1,
                "modified": 0,
                "removed": 0,
            },
        )
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_B)
        link = PlaidAccountLink.objects.get(pk=self.link.pk)
        self.assertIsNotNone(link.anchor_applied_at)
        account = Account.objects.get(pk=self.checking.pk)
        # Anchor 100.00 minus net income of -21.00 (21 posted expenses), so the
        # derived balance lands exactly on the provider snapshot.
        self.assertEqual(account.opening_balance, Decimal("121.00"))
        self.assertEqual(account.current_balance, Decimal("100.00"))

    def test_blocked_run_leaves_a_pre_existing_cursor_unmoved(self):
        self.connection.sync_cursor = CURSOR_A
        self.connection.transactions_update_status = (
            TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE
        )
        self.connection.save(
            update_fields=["sync_cursor", "transactions_update_status"]
        )

        with self.patched_gateway(FakeSyncGateway([PlaidGatewayError()])):
            response = self.post_sync(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_A)
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ERROR)
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE,
        )
        self.assertFalse(Transaction.objects.filter(user=self.user).exists())

    def test_anchor_fail_closed_returns_503_without_applying_rows(self):
        # A link whose captured provider balance is missing must block the
        # whole window rather than anchor against partial history.
        PlaidAccountLink.objects.filter(pk=self.link.pk).update(
            anchor_provider_current_balance=None
        )
        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(
                            transaction_id="anchor-less-tx",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="5.00",
                        ),
                    ),
                    next_cursor=CURSOR_A,
                    has_more=False,
                    status="HISTORICAL_UPDATE_COMPLETE",
                )
            ]
        )

        with self.patched_gateway(gateway):
            response = self.post_sync(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        self.connection.refresh_from_db()
        self.assertIsNone(self.connection.sync_cursor)
        self.assertFalse(Transaction.objects.filter(user=self.user).exists())
        link = PlaidAccountLink.objects.get(pk=self.link.pk)
        self.assertIsNone(link.anchor_applied_at)
        self.assertEqual(
            Account.objects.get(pk=self.checking.pk).opening_balance,
            Decimal("0.00"),
        )
        self.assertTrue(self.connection.last_sync_error.startswith(SYNC_ERROR_TAG))
        self.assertIn("anchor", self.connection.last_sync_error.lower())
