"""The one project-name rule every write path shares.

A project name is 1 to ``PROJECT_NAME_MAX`` characters once trimmed. Every path that
writes one checks it here (``check_project_name``) and refuses with the same words
(``PROJECT_NAME_LENGTH_ERROR``), each in its own status: ``POST /app/projects``, the
document publish and its dry run (``documents.validate_project``), the book PUT, the
Feedback capture, the install Connect (``installs_api._free_project_name`` keeps its
``-N`` suffix inside the bound), Listen and reader state (``ProjectName``), and the
CLI's own check before it sends. Each path keeps its own character rule; this only
aligns the length.

Tenant #1 keeps its projects under ``docs/``, next to the MkDocs site's tracked
folders, so a project there named like one of them (``TENANT_ONE_RESERVED``) would
write into tracked files: every path that creates a project refuses those names for
tenant #1 (``reserved_for_tenant_one``). The match is case-insensitive (casefolded)
everywhere, because a case-insensitive filesystem (macOS, where the platform is
developed) maps ``Assets`` onto ``docs/assets/``; another tenant's root holds no such
folder, so the names are free there.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import AfterValidator

PROJECT_NAME_MAX = 200
PROJECT_NAME_LENGTH_ERROR = f"project name must be 1 to {PROJECT_NAME_MAX} characters"

#: The MkDocs site's tracked folders under ``docs/`` (also ``deletion.TRACKED_DOCS_DIRS``).
TENANT_ONE_RESERVED = frozenset({"assets", "javascripts", "stylesheets"})
PROJECT_NAME_RESERVED_ERROR = (
    "that project name is reserved in this org: the site's own folder has it"
)


def check_project_name(value: str) -> str:
    """``value`` unchanged when it is 1 to ``PROJECT_NAME_MAX`` characters once trimmed;
    else ``ValueError(PROJECT_NAME_LENGTH_ERROR)``. Trimming is the caller's own call."""

    if not isinstance(value, str) or not 1 <= len(value.strip()) <= PROJECT_NAME_MAX:
        raise ValueError(PROJECT_NAME_LENGTH_ERROR)
    return value


def reserved_for_tenant_one(name: str) -> bool:
    """Whether ``name`` is a tracked ``docs/`` folder's name, in any case."""

    return name.strip().casefold() in TENANT_ONE_RESERVED


#: A request body's project name, under the shared rule (a 422 when it fails).
ProjectName = Annotated[str, AfterValidator(check_project_name)]
