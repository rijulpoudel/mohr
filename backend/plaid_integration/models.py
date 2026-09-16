"""Persistence models for the Plaid Sandbox synchronization milestone.

Implements the ``docs/plaid.md`` section 4 contract: one row per Plaid
Item, one row per linked Mohr account, and a durable inbox for verified
webhooks. Database constraints back every invariant that PostgreSQL can
express in a single row; cross-table ownership validation lives in
``clean()`` because database checks cannot follow foreign keys.
"""

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models


class PlaidConnectionStatus(models.TextChoices):
    ACTIVE = "active", "Active"
    UPDATING = "updating", "Updating"
    ERROR = "error", "Error"
    REVOKED = "revoked", "Revoked"
    DISCONNECTED = "disconnected", "Disconnected"


class TransactionsUpdateStatus(models.TextChoices):
    NOT_READY = "not_ready", "Not ready"
    INITIAL_UPDATE_COMPLETE = "initial_update_complete", "Initial update complete"
    HISTORICAL_UPDATE_COMPLETE = (
        "historical_update_complete",
        "Historical update complete",
    )


class PlaidConnection(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="plaid_connections",
    )
    item_id = models.CharField(max_length=100)
    access_token_encrypted = models.TextField(null=True, blank=True)
    encryption_key_id = models.CharField(max_length=64, null=True, blank=True)
    institution_name = models.CharField(max_length=200)
    status = models.CharField(
        max_length=20,
        choices=PlaidConnectionStatus.choices,
        default=PlaidConnectionStatus.ACTIVE,
    )
    sync_cursor = models.TextField(null=True, blank=True)
    transactions_update_status = models.CharField(
        max_length=40,
        choices=TransactionsUpdateStatus.choices,
        null=True,
        blank=True,
    )
    sync_due = models.BooleanField(default=False)
    last_synced_at = models.DateTimeField(null=True, blank=True)
    last_sync_error = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("created_at", "id")
        constraints = [
            models.UniqueConstraint(
                fields=["item_id"],
                name="plaid_connection_item_id_unique",
            ),
            models.CheckConstraint(
                condition=models.Q(status__in=PlaidConnectionStatus.values),
                name="plaid_connection_status_valid",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(transactions_update_status__isnull=True)
                    | models.Q(
                        transactions_update_status__in=TransactionsUpdateStatus.values
                    )
                ),
                name="plaid_connection_transactions_update_status_valid",
            ),
        ]
        indexes = [
            models.Index(
                fields=["encryption_key_id"],
                name="plaid_conn_key_id_idx",
            ),
        ]

    def __str__(self):
        return f"{self.institution_name} ({self.status})"

    def __repr__(self):
        return f"<PlaidConnection id={self.pk} status={self.status!r}>"


class PlaidAccountLink(models.Model):
    connection = models.ForeignKey(
        "PlaidConnection",
        on_delete=models.CASCADE,
        related_name="account_links",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="plaid_account_links",
    )
    account = models.ForeignKey(
        "accounts.Account",
        on_delete=models.RESTRICT,
        related_name="plaid_account_links",
    )
    plaid_account_id = models.CharField(max_length=100)
    plaid_type = models.CharField(max_length=50)
    plaid_subtype = models.CharField(max_length=50)
    mask = models.CharField(max_length=4)
    anchor_provider_current_balance = models.DecimalField(
        max_digits=14,
        decimal_places=2,
        null=True,
        blank=True,
    )
    anchor_applied_at = models.DateTimeField(null=True, blank=True)
    provider_current_balance = models.DecimalField(
        max_digits=14,
        decimal_places=2,
        null=True,
        blank=True,
    )
    provider_available_balance = models.DecimalField(
        max_digits=14,
        decimal_places=2,
        null=True,
        blank=True,
    )

    class Meta:
        ordering = ("id",)
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "plaid_account_id"],
                name="plaid_account_link_connection_plaid_account_id_unique",
            ),
            models.UniqueConstraint(
                fields=["user", "account"],
                name="plaid_account_link_user_account_unique",
            ),
        ]

    def clean(self):
        if self.connection_id and self.connection.user_id != self.user_id:
            raise ValidationError(
                {
                    "connection": (
                        "Connection must belong to the same user as the account link."
                    )
                }
            )
        if self.account_id and self.account.user_id != self.user_id:
            raise ValidationError(
                {"account": "Account must belong to the same user as the account link."}
            )

    def __str__(self):
        return f"{self.plaid_account_id} ({self.mask})"


class PlaidWebhookEvent(models.Model):
    connection = models.ForeignKey(
        "PlaidConnection",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="webhook_events",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="plaid_webhook_events",
    )
    webhook_type = models.CharField(max_length=50)
    webhook_code = models.CharField(max_length=50)
    item_id = models.CharField(max_length=100)
    idempotency_key = models.CharField(max_length=64)
    initial_update_complete = models.BooleanField(default=False)
    historical_update_complete = models.BooleanField(default=False)
    received_at = models.DateTimeField()
    processed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ("-received_at", "-id")
        constraints = [
            models.UniqueConstraint(
                fields=["idempotency_key"],
                name="plaid_webhook_event_idempotency_key_unique",
            ),
            models.CheckConstraint(
                condition=(
                    (models.Q(connection__isnull=True) & models.Q(user__isnull=True))
                    | (
                        models.Q(connection__isnull=False)
                        & models.Q(user__isnull=False)
                    )
                ),
                name="plaid_webhook_event_connection_user_null_pair",
            ),
        ]

    def clean(self):
        if self.connection_id and self.connection.user_id != self.user_id:
            raise ValidationError(
                {
                    "connection": (
                        "Connection must belong to the same user as the webhook event."
                    )
                }
            )

    def __str__(self):
        return f"{self.webhook_type} {self.webhook_code} {self.received_at}"
