import click

from mlflow.server.auth.db import cli as db_cli


@click.group()
def commands():
    pass


commands.add_command(db_cli.commands)


# --------------------------------------------------------------------------
# Tenant management CLI
# --------------------------------------------------------------------------

def _get_auth_client():
    from mlflow.server.auth.client import AuthServiceClient
    import mlflow
    return AuthServiceClient(mlflow.get_tracking_uri())


@commands.group("tenant")
def tenant_commands():
    """Manage MLflow tenants (multi-tenancy)."""


@tenant_commands.command("create")
@click.option("--slug", required=True, help="Unique tenant slug (URL-safe identifier).")
@click.option("--name", required=True, help="Human-readable tenant name.")
@click.option("--storage-root", default=None, help="Root artifact path for this tenant.")
@click.option("--max-experiments", default=None, type=int, help="Experiment quota (unlimited if omitted).")
@click.option("--max-users", default=None, type=int, help="User quota (unlimited if omitted).")
def create_tenant(slug, name, storage_root, max_experiments, max_users):
    """Create a new tenant."""
    client = _get_auth_client()
    tenant = client.create_tenant(
        slug=slug,
        name=name,
        storage_root=storage_root,
        max_experiments=max_experiments,
        max_users=max_users,
    )
    click.echo(f"Tenant created: {tenant.to_json()}")


@tenant_commands.command("get")
@click.option("--slug", required=True, help="Tenant slug to look up.")
def get_tenant(slug):
    """Get details of a tenant."""
    client = _get_auth_client()
    tenant = client.get_tenant(slug)
    click.echo(tenant.to_json())


@tenant_commands.command("list")
def list_tenants():
    """List all tenants."""
    client = _get_auth_client()
    tenants = client.list_tenants()
    for t in tenants:
        click.echo(t.to_json())


@tenant_commands.command("update")
@click.option("--slug", required=True, help="Tenant slug to update.")
@click.option("--name", default=None, help="New human-readable name.")
@click.option("--storage-root", default=None, help="New artifact root path.")
@click.option("--max-experiments", default=None, type=int, help="New experiment quota.")
@click.option("--max-users", default=None, type=int, help="New user quota.")
def update_tenant(slug, name, storage_root, max_experiments, max_users):
    """Update a tenant's settings."""
    client = _get_auth_client()
    tenant = client.update_tenant(
        slug=slug,
        name=name,
        storage_root=storage_root,
        max_experiments=max_experiments,
        max_users=max_users,
    )
    click.echo(f"Tenant updated: {tenant.to_json()}")


@tenant_commands.command("delete")
@click.option("--slug", required=True, help="Tenant slug to delete.")
def delete_tenant(slug):
    """Delete a tenant (cannot delete the 'default' tenant)."""
    client = _get_auth_client()
    client.delete_tenant(slug)
    click.echo(f"Tenant '{slug}' deleted.")
