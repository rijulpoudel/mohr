"""Bounded retry of relocated Plaid item removals (issue #39 slice D3).

One invocation processes at most ``--batch-size`` due pending
``PlaidItemRemovalRequest`` rows through the bounded exponential-backoff
driver. The output prints counts only: never tokens, key ids, item ids, or
provider detail.
"""

from django.core.management.base import BaseCommand, CommandError

from plaid_integration.services import process_plaid_item_removals

DEFAULT_BATCH_SIZE = 500
MAX_BATCH_SIZE = 5000


class Command(BaseCommand):
    help = "Retry due Plaid item removals with a bounded exponential backoff."

    def add_arguments(self, parser):
        parser.add_argument(
            "--batch-size",
            type=int,
            default=DEFAULT_BATCH_SIZE,
            help=(
                f"Maximum removal rows processed in one invocation "
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
        result = process_plaid_item_removals(batch_size)
        self.stdout.write(
            f"Removed {result.removed} item(s), retried {result.retried} "
            f"item(s), failed {result.failed} item(s), "
            f"skipped {result.skipped} item(s)."
        )
