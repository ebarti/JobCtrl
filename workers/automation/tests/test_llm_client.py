"""LLM client structured-output regressions."""

from __future__ import annotations

import json

import httpx

from jobhunter.domain.materials.use_cases import TAILORED_RESUME_RESPONSE_SCHEMA
from jobhunter.llm import LLMClient


def test_openai_compat_path_sends_strict_tailoring_schema() -> None:
    requests: list[dict] = []

    def _openai_response(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(
            status_code=200,
            json={
                "choices": [
                    {
                        "message": {"content": "{}"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            },
        )

    client = LLMClient(
        base_url="https://api.openai.com/v1",
        model="gpt-test",
        api_key="test-key",
    )
    client._client.close()
    client._client = httpx.Client(transport=httpx.MockTransport(_openai_response))

    try:
        response = client.chat(
            [{"role": "user", "content": "tailor"}],
            response_schema=TAILORED_RESUME_RESPONSE_SCHEMA,
        )
    finally:
        client.close()

    assert response == "{}"
    assert len(requests) == 1
    response_format = requests[0]["response_format"]
    assert response_format["type"] == "json_schema"
    assert response_format["json_schema"]["strict"] is True
    schema = response_format["json_schema"]["schema"]
    experience_item = schema["properties"]["experience_updates"]["items"]
    assert set(experience_item["required"]) == {"id", "title", "bullets"}
