"""One SQLite authority for thread generations, attestations and reminders."""

from __future__ import annotations

import json
from contextlib import contextmanager

from .domain import fingerprint, now


class SqliteOutreachStore:
    def __init__(self, database, events):
        self.database, self.events = database, events

    @contextmanager
    def read(self, connection=None):
        if connection is not None:
            yield _Session(connection, self.events)
        else:
            with self.database.connect() as conn:
                yield _Session(conn, self.events)

    @contextmanager
    def write(self):
        with self.database.transaction() as conn:
            yield _Session(conn, self.events)


class _Session:
    def __init__(self, connection, events):
        self.connection, self.events = connection, events

    def thread(self, thread_id):
        row = self.connection.execute("SELECT record_json FROM outreach_records WHERE thread_id=?", (thread_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def for_contact(self, contact_id, job_id):
        row = self.connection.execute("SELECT record_json FROM outreach_records WHERE target_key=?", (fingerprint([contact_id, job_id]),)).fetchone()
        return json.loads(row[0]) if row else None

    def threads(self):
        return [json.loads(row[0]) for row in self.connection.execute("SELECT record_json FROM outreach_records ORDER BY updated_at DESC,thread_id")]

    def put(self, thread):
        self.connection.execute("INSERT INTO outreach_records VALUES(?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json,updated_at=excluded.updated_at",
                                (thread["threadId"], fingerprint([thread["contactId"], thread["jobId"]]), thread["revision"], json.dumps(thread, ensure_ascii=False), thread["updatedAt"]))

    def receipt(self, request_id):
        row = self.connection.execute("SELECT payload_hash,record_json FROM outreach_action_receipts WHERE request_id=?", (request_id,)).fetchone()
        return {"payloadHash": row[0], "sendLog": json.loads(row[1])} if row else None

    def put_receipt(self, request_id, payload_hash, send_log):
        self.connection.execute("INSERT INTO outreach_action_receipts VALUES(?,?,?,?)", (request_id, payload_hash, json.dumps(send_log, ensure_ascii=False), now()))

    def determination(self, record):
        self.connection.execute("INSERT INTO outreach_model_records VALUES(?,?,?,?) ON CONFLICT(determination_id) DO NOTHING",
                                (record["determinationId"], record["operation"], json.dumps(record, ensure_ascii=False), record["createdAt"]))

    def model_record(self, determination_id):
        row = self.connection.execute("SELECT record_json FROM outreach_model_records WHERE determination_id=?", (determination_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def publication_receipt(self, request_id):
        row = self.connection.execute("SELECT payload_hash,publication_json FROM outreach_proposal_receipts WHERE request_id=?", (request_id,)).fetchone()
        return {"payloadHash": row[0], "publication": json.loads(row[1])} if row else None

    def put_publication_receipt(self, request_id, payload_hash, publication):
        self.connection.execute("INSERT INTO outreach_proposal_receipts VALUES(?,?,?,?)",
                                (request_id, payload_hash, json.dumps(publication), now()))

    def event(self, name, aggregate_id, payload):
        self.events.append(self.connection, name, payload, feature="outreach", aggregate_id=aggregate_id)
