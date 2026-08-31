from django.urls import reverse
from rest_framework import status
from rest_framework.test import APITestCase


class HealthCheckAPITests(APITestCase):
    def test_health_check_returns_ok(self):
        response = self.client.get(reverse("health-check"))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, {"status": "ok"})
