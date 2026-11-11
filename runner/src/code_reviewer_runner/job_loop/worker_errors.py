# SPDX-License-Identifier: LicenseRef-Proprietary

"""Why a Worker could not start its job (#323). The codes are stable: they are logged, the
Dispatcher's launcher may read them from the log, and an operator searches for them. The message of
an error names the property, never a value (the start document and the answers hold secrets)."""

from enum import IntEnum, StrEnum


class WorkerExit(IntEnum):
    """The exit code of `code-reviewer-worker --once`."""

    # The job succeeded, or it was given back to the queue (a shutdown): nothing more to do.
    OK = 0
    # The job failed, the app no longer held it, or its result could not be delivered.
    FAILED = 1
    # The Worker could not start the job: its start document, its configuration, an app that cannot
    # serve it, or a job it could not fetch.
    SETUP_ERROR = 2
    # #980: the job failed because the subscription of the device refused it. The result carries
    # the code the app stores; the exit code carries the reason to the dispatcher of the device,
    # which cannot read the result. A device's dispatcher withdraws the credential (the login was
    # refused: 20), puts it aside (the usage limit: 21) or drops the model (22). Any other
    # dispatcher reads them as a failed job.
    SUBSCRIPTION_AUTH = 20
    SUBSCRIPTION_LIMIT = 21
    SUBSCRIPTION_MODEL_REFUSED = 22


class WorkerFailure(StrEnum):
    INPUT_INVALID = "worker_input_invalid"
    SETTINGS_INVALID = "worker_settings_invalid"
    # The app has no Worker API (an app from before the hosted deployment).
    APP_UNSUPPORTED = "worker_app_unsupported"
    # The job could not be fetched: no answer after the bounded retries.
    APP_UNREACHABLE = "worker_app_unreachable"
    CREDENTIAL_INVALID = "worker_credential_invalid"
    # The app does not hold the job for this Worker any more, or ended it.
    JOB_ENDED = "worker_job_ended"
    # The app could not mint the job's credentials right now and gave the job back.
    JOB_GIVEN_BACK = "worker_job_given_back"
    FETCH_REFUSED = "worker_fetch_refused"
    # A signal arrived before the job was fetched.
    STOPPED = "worker_stopped"


class WorkerSetupError(Exception):
    def __init__(self, code: WorkerFailure, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail
