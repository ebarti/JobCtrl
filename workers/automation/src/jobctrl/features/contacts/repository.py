"""SQLite adapter. It writes only Contacts-owned tables and committed events."""

from __future__ import annotations

import json
from contextlib import contextmanager


class SqliteContactsStore:
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

    def contact(self, contact_id):
        row = self.connection.execute("SELECT record_json FROM contacts_records WHERE contact_id=? AND deleted_at IS NULL", (contact_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def contacts(self):
        return [json.loads(row[0]) for row in self.connection.execute("SELECT record_json FROM contacts_records WHERE deleted_at IS NULL ORDER BY updated_at DESC,contact_id")]

    def put_contact(self, record):
        self.connection.execute(
            "INSERT INTO contacts_records(contact_id,revision,employer,job_id,deleted_at,updated_at,record_json) VALUES(?,?,?,?,?,?,?) "
            "ON CONFLICT(contact_id) DO UPDATE SET revision=excluded.revision,employer=excluded.employer,job_id=excluded.job_id,deleted_at=excluded.deleted_at,updated_at=excluded.updated_at,record_json=excluded.record_json",
            (record["contactId"], record["revision"], record["employer"], record["jobId"], record["deletedAt"], record["updatedAt"], json.dumps(record, ensure_ascii=False)),
        )

    def task(self, task_id):
        row = self.connection.execute("SELECT record_json FROM contacts_research WHERE task_id=?", (task_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def tasks(self):
        return [json.loads(row[0]) for row in self.connection.execute("SELECT record_json FROM contacts_research ORDER BY updated_at DESC,task_id")]

    def put_task(self, record):
        self.connection.execute("INSERT INTO contacts_research VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json,updated_at=excluded.updated_at",
                                (record["taskId"], record["revision"], json.dumps(record, ensure_ascii=False), record["updatedAt"]))

    def determination(self, record):
        self.connection.execute("INSERT INTO contacts_model_records VALUES(?,?,?,?) ON CONFLICT(determination_id) DO NOTHING",
                                (record["determinationId"], record["operation"], json.dumps(record, ensure_ascii=False), record["createdAt"]))

    def model_record(self, determination_id):
        row = self.connection.execute("SELECT record_json FROM contacts_model_records WHERE determination_id=?", (determination_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def event(self, name, aggregate_id, payload):
        self.events.append(self.connection, name, payload, feature="contacts", aggregate_id=aggregate_id)
