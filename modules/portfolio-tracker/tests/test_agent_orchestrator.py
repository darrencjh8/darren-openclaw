import pytest

from src.agent.orchestrator import AgentOrchestrator


class FakeDeepSeekClient:
    def __init__(self):
        self.call_count = 0

    async def chat(self, messages, tools=None, max_tokens=2000):
        self.call_count += 1
        class FakeUsage:
            prompt_tokens = 100
            completion_tokens = 50
        class FakeChoice:
            class FakeMessage:
                content = "Done processing."
                tool_calls = None
            message = FakeMessage()
        class FakeResponse:
            usage = FakeUsage()
            choices = [FakeChoice()]
        return FakeResponse()


class FakeToolRegistry:
    def __init__(self):
        self.calls = []

    def set_telegram_sender(self, sender):
        pass

    def set_event_context(self, **kwargs):
        pass

    def get_tool_schemas(self):
        return []

    async def execute_tool(self, name, args):
        self.calls.append((name, args))
        return '{"status": "ok"}'


class FakeDedupJournal:
    def check(self, *args, **kwargs):
        return False

    def record(self, *args, **kwargs):
        pass


class FakeMemoryStore:
    def recall(self, *args, **kwargs):
        return None


@pytest.fixture
def orchestrator():
    llm = FakeDeepSeekClient()
    tools = FakeToolRegistry()
    dedup = FakeDedupJournal()
    memory = FakeMemoryStore()
    return AgentOrchestrator(llm, tools, dedup, memory)


@pytest.mark.asyncio
async def test_orchestrator_processes_event(orchestrator):
    result = await orchestrator.process_event("ibkr_flex_query", "<xml>test</xml>", "corr-1")
    assert result["action"] == "completed"


@pytest.mark.asyncio
async def test_orchestrator_handles_balance_sync(orchestrator):
    result = await orchestrator.process_event("balance_sync", "", "corr-2")
    assert result["action"] == "completed"


@pytest.mark.asyncio
async def test_orchestrator_handles_taxonomy_export(orchestrator):
    result = await orchestrator.process_event("taxonomy_export", "", "corr-3")
    assert result["action"] == "completed"


@pytest.mark.asyncio
async def test_handle_user_response_approve(orchestrator):
    import asyncio as _asyncio
    orchestrator._pending = {"question": "test"}
    orchestrator._confirmation_event = _asyncio.Event()
    orchestrator._confirmation_response = None
    result = orchestrator.handle_user_response("approve")
    assert result == "approved"
    assert orchestrator._confirmation_response == "approved"
    assert orchestrator._confirmation_event.is_set()


@pytest.mark.asyncio
async def test_handle_user_response_reject(orchestrator):
    import asyncio as _asyncio
    orchestrator._pending = {"question": "test"}
    orchestrator._confirmation_event = _asyncio.Event()
    orchestrator._confirmation_response = None
    result = orchestrator.handle_user_response("reject")
    assert result == "rejected"
    assert orchestrator._confirmation_response == "rejected"
    assert orchestrator._confirmation_event.is_set()


@pytest.mark.asyncio
async def test_handle_user_response_unknown_returns_none(orchestrator):
    import asyncio as _asyncio
    orchestrator._pending = {"question": "test"}
    orchestrator._confirmation_event = _asyncio.Event()
    orchestrator._confirmation_response = None
    result = orchestrator.handle_user_response("maybe")
    assert result is None
    assert orchestrator._pending is not None
