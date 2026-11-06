"""HTTP reads for the preparation application."""

from starlette.responses import JSONResponse
from starlette.routing import Route

from jobctrl.app.errors import AppError
from jobctrl.app.preparation import PreparationService


def build_routes(service: PreparationService) -> tuple[Route, ...]:
    async def listing(request):
        raw = request.query_params.get("limit", "100")
        if not raw.isdecimal() or len(raw) > 4:
            raise AppError("invalid_pagination", "Use a run limit from 1 to 1,000.")
        return JSONResponse(service.list_runs(int(raw)))

    async def detail(request):
        return JSONResponse(service.get_run(request.path_params["run_id"]))

    return (
        Route("/v1/preparation/runs", listing, methods=["GET"]),
        Route("/v1/preparation/runs/{run_id}", detail, methods=["GET"]),
    )
