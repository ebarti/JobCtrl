"""JobStreaming acknowledgement storage in the same transaction as received listings."""

from contextlib import contextmanager, nullcontext
from threading import local

from jobstreaming.checkpoint import CheckpointConflictError
from jobstreaming.events import SearchCheckpoint


def read_checkpoint(connection, run_id, unit_id):
    row = connection.execute(
        "SELECT state_json FROM discovery_provider_checkpoints WHERE run_id=? AND unit_id=?", (run_id, unit_id),
    ).fetchone()
    if row is None:
        return None
    checkpoint = SearchCheckpoint.model_validate_json(row[0])
    keys = {site: [] for site in checkpoint.adapters}
    for site, key in connection.execute(
        "SELECT site,job_key FROM discovery_provider_keys WHERE run_id=? AND unit_id=? ORDER BY site,ordinal",
        (run_id, unit_id),
    ):
        keys[site].append(key)
    adapters = {}
    for site, adapter in checkpoint.adapters.items():
        if len(keys[site]) != adapter.emitted_count:
            raise CheckpointConflictError("The number of acknowledged listings disagrees with the stored cursor.")
        adapters[site] = adapter.model_copy(update={"seen_job_keys": tuple(keys[site])})
    return checkpoint.model_copy(update={"adapters": adapters})


def header_json(checkpoint):
    return checkpoint.model_dump_json(exclude={"adapters": {"__all__": {"seen_job_keys"}}})


def insert_checkpoint(connection, run_id, unit_id, checkpoint):
    connection.execute(
        "INSERT INTO discovery_provider_checkpoints VALUES(?,?,?,?,?)",
        (run_id, unit_id, checkpoint.generation, checkpoint.revision, header_json(checkpoint)),
    )
    for site, adapter in checkpoint.adapters.items():
        for ordinal, key in enumerate(adapter.seen_job_keys, 1):
            connection.execute("INSERT INTO discovery_provider_keys VALUES(?,?,?,?,?)", (run_id, unit_id, site, key, ordinal))


class ProviderCheckpointStore:
    def __init__(self, repository, lease, unit_id):
        self.repository = repository
        self.lease = lease
        self.coordinate = lease["run_id"], unit_id
        self._local = local()

    @contextmanager
    def writing(self, connection):
        self._local.connection = connection
        try:
            yield
        finally:
            self._local.connection = None

    def _transaction(self):
        conn = getattr(self._local, "connection", None)
        return nullcontext(conn) if conn is not None else self.repository.database.transaction()

    def load(self):
        with self.repository.database.connect() as conn:
            return read_checkpoint(conn, *self.coordinate)

    def save(self, checkpoint):
        with self._transaction() as conn:
            self.repository.guard_run(conn, self.lease)
            insert_checkpoint(conn, *self.coordinate, checkpoint)

    def save_incremental(self, write):
        checkpoint = write.checkpoint
        with self._transaction() as conn:
            self.repository.guard_run(conn, self.lease)
            changed = conn.execute(
                "UPDATE discovery_provider_checkpoints SET revision=?,state_json=? "
                "WHERE run_id=? AND unit_id=? AND generation=? AND revision=?",
                (checkpoint.revision, header_json(checkpoint), *self.coordinate, checkpoint.generation, checkpoint.revision - 1),
            ).rowcount
            if changed != 1:
                raise CheckpointConflictError("The provider position belongs to a different search execution.")
            if write.new_seen_job_key is not None:
                site = write.adapter_site.value
                conn.execute("INSERT INTO discovery_provider_keys VALUES(?,?,?,?,?)",
                             (*self.coordinate, site, write.new_seen_job_key, checkpoint.adapters[site].emitted_count))

    def clear(self):
        raise CheckpointConflictError("Resetting a saved position requires a new search.")
