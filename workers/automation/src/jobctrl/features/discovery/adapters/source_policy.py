"""Public-address policy is a real network boundary, never a source inference."""

import asyncio

from jobctrl.network.url_safety import validate_public_http_url


class PublicSourceDestinationPolicy:
    async def is_public(self, url):
        decision = await asyncio.to_thread(validate_public_http_url, url)
        return decision.allowed
