from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import declarative_base, relationship

from mlflow.server.auth.entities import (
    Role,
    RolePermission,
    TeamMembership,
    Tenant,
    User,
    UserRoleAssignment,
)
from mlflow.tenant_context import DEFAULT_TENANT_SLUG

Base = declarative_base()


class SqlTenant(Base):
    __tablename__ = "tenants"

    id = Column(Integer(), primary_key=True)
    slug = Column(String(63), unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    storage_root = Column(String(1024), nullable=True)
    max_experiments = Column(BigInteger(), nullable=True)
    max_users = Column(BigInteger(), nullable=True)
    created_at = Column(DateTime(), nullable=False, server_default=func.now())

    memberships = relationship("SqlTeamMembership", backref="tenant", cascade="all, delete-orphan")
    roles = relationship("SqlRole", backref="tenant", cascade="all, delete-orphan")

    def to_mlflow_entity(self):
        return Tenant(
            id_=self.id,
            slug=self.slug,
            name=self.name,
            storage_root=self.storage_root,
            max_experiments=self.max_experiments,
            max_users=self.max_users,
        )


class SqlUser(Base):
    """Global user account — not bound to any single tenant.

    Team membership is expressed through ``SqlTeamMembership`` rows.
    The ``is_admin`` flag is reserved for the system superuser account
    (the ``admin`` user in the default tenant) and grants cross-tenant
    access.  All other per-team admin status lives in
    ``SqlTeamMembership.role``.
    """
    __tablename__ = "users"

    id = Column(Integer(), primary_key=True)
    username = Column(String(255), unique=True, nullable=False)
    password_hash = Column(String(255))
    is_admin = Column(Boolean, default=False)
    # Profile fields
    display_name = Column(String(255), nullable=True)
    email = Column(String(255), nullable=True)
    title = Column(String(255), nullable=True)
    department = Column(String(255), nullable=True)
    location = Column(String(255), nullable=True)
    bio = Column(Text(), nullable=True)
    github = Column(String(255), nullable=True)
    orcid = Column(String(64), nullable=True)
    avatar_url = Column(Text(), nullable=True)

    memberships = relationship(
        "SqlTeamMembership",
        backref="user",
        cascade="all, delete-orphan",
    )
    user_role_assignments = relationship(
        "SqlUserRoleAssignment",
        backref="user",
        foreign_keys="SqlUserRoleAssignment.user_id",
        cascade="all, delete-orphan",
    )

    def to_mlflow_entity(self):
        return User(
            id_=self.id,
            username=self.username,
            password_hash=self.password_hash,
            is_admin=self.is_admin,
            display_name=self.display_name,
            email=self.email,
            title=self.title,
            department=self.department,
            location=self.location,
            bio=self.bio,
            github=self.github,
            orcid=self.orcid,
            avatar_url=self.avatar_url,
        )


class SqlTeamMembership(Base):
    """Maps a user to a tenant with a per-team role.

    role: 'admin' — can manage users and permissions within this team
          'member' — regular participant
    """
    __tablename__ = "team_memberships"

    id = Column(Integer(), primary_key=True)
    user_id = Column(Integer(), ForeignKey("users.id"), nullable=False)
    tenant_id = Column(Integer(), ForeignKey("tenants.id"), nullable=False)
    role = Column(String(32), nullable=False, default="member")

    __table_args__ = (
        UniqueConstraint("user_id", "tenant_id", name="uq_team_membership"),
        Index("idx_team_memberships_user_id", "user_id"),
        Index("idx_team_memberships_tenant_id", "tenant_id"),
    )

    def to_mlflow_entity(self):
        return TeamMembership(
            id_=self.id,
            user_id=self.user_id,
            tenant_id=self.tenant_id,
            role=self.role,
        )


class SqlRole(Base):
    __tablename__ = "roles"

    id = Column(Integer(), primary_key=True)
    name = Column(String(255), nullable=False)
    workspace = Column(String(63), nullable=False)
    description = Column(String(1024), nullable=True)
    tenant_id = Column(Integer(), ForeignKey("tenants.id"), nullable=False)
    permissions = relationship("SqlRolePermission", backref="role", cascade="all, delete-orphan")
    user_assignments = relationship(
        "SqlUserRoleAssignment", backref="role", cascade="all, delete-orphan"
    )
    __table_args__ = (
        UniqueConstraint("tenant_id", "workspace", "name", name="unique_tenant_workspace_role_name"),
        Index("idx_roles_workspace", "workspace"),
        Index("idx_roles_tenant_id", "tenant_id"),
    )

    def to_mlflow_entity(self):
        return Role(
            id_=self.id,
            name=self.name,
            workspace=self.workspace,
            description=self.description,
            permissions=[p.to_mlflow_entity() for p in self.permissions],
        )


class SqlRolePermission(Base):
    __tablename__ = "role_permissions"

    id = Column(Integer(), primary_key=True)
    role_id = Column(Integer, ForeignKey("roles.id"), nullable=False)
    resource_type = Column(String(64), nullable=False)
    resource_pattern = Column(String(255), nullable=False)
    permission = Column(String(255), nullable=False)
    __table_args__ = (
        UniqueConstraint(
            "role_id", "resource_type", "resource_pattern", name="unique_role_resource_perm"
        ),
        Index("idx_role_permissions_role_id", "role_id"),
    )

    def to_mlflow_entity(self):
        return RolePermission(
            id_=self.id,
            role_id=self.role_id,
            resource_type=self.resource_type,
            resource_pattern=self.resource_pattern,
            permission=self.permission,
        )


class SqlUserRoleAssignment(Base):
    __tablename__ = "user_role_assignments"

    id = Column(Integer(), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    role_id = Column(Integer, ForeignKey("roles.id"), nullable=False)
    __table_args__ = (
        UniqueConstraint("user_id", "role_id", name="unique_user_role"),
        Index("idx_user_role_assignments_user_id", "user_id"),
        Index("idx_user_role_assignments_role_id", "role_id"),
    )

    def to_mlflow_entity(self):
        return UserRoleAssignment(
            id_=self.id,
            user_id=self.user_id,
            role_id=self.role_id,
        )
