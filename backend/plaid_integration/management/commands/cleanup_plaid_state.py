"""Bounded cleanup of Plaid webhook inbox state (issue #39 slice C).

One invocation bounds the durable inbox: at most ``--batch-size`` processed
webhook rows older than ``PLAID_WEBHOOK_PROCESSED_RETENTION_DAYS`` are
deleted (oldest first), at most ``--batch-size`` expired or consumed exchange
handles are deleted (oldest first), and at most ``--batch-size`` additional
oldest processed webhook rows are evicted when the table remains above
``PLAID_WEBHOOK_INBOX_CAP``. Unprocessed matched webhook rows and active
handles are never deleted, and the output prints counts only.
"""

from django.core.management.base import BaseCommand, CommandError

from plaid_integration.services import cleanup_plaid_state

DEFAULT_BATCH_SIZE = 500
MAX_BATCH_SIZE = 5000


class Command(BaseCommand):
    help = (
        "Bound Plaid webhook inbox growth and purge expired or consumed "
        "exchange handles."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--batch-size",
            type=int,
            default=DEFAULT_BATCH_SIZE,
            help=(
                f"Maximum rows deleted per kind in one invocation "
                f"(default {DEFAULT_BATCH_SIZE}, max {MAX_BATCH_SIZE})."
            ),
        )

    def handle(self, *args, **options):
        batch_size = options["batch_size"]
        if batch_size < 1 or batch_size > MAX_BATCH_SIZE:
            raise CommandError(
                f"--batch-size must be a positive integer no greater than "
                f"{MAX_BATCH_SIZE}."
            )
        result = cleanup_plaid_state(batch_size)
        self.stdout.write(
            f"Deleted {result.webhook_events_deleted} webhook event(s) and "
            f"{result.exchange_handles_deleted} exchange handle(s)."
        )
