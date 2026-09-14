"""CloudFormation custom-resource handler that seeds dev-only demo Cognito users.

Dev convenience only (never invoked for prod, see auth-stack.ts): creates one Cognito
user per (silo, role) pair, plus the multi-role identities in config/agent-silos.ts,
so the role-filtered RAG demo has ready-made logins without a real signup flow.

Every account shares one password, generated at deploy time and passed here by secret
ARN rather than by value -- custom-resource properties are stored in the
CloudFormation template and readable via cloudformation:GetTemplate. These are still
shared, long-lived accounts: a demo convenience, not a security boundary.
"""

import json
import os

import boto3

REGION = os.environ["AWS_REGION"]
USER_POOL_ID = os.environ["USER_POOL_ID"]

_cognito = boto3.client("cognito-idp", region_name=REGION)
_secrets = boto3.client("secretsmanager", region_name=REGION)


def _password(secret_arn: str) -> str:
    """Fetch the shared demo password when the resource runs."""
    return _secrets.get_secret_value(SecretId=secret_arn)["SecretString"]


def _create_or_update_user(username: str, password: str, groups: list[str]) -> None:
    try:
        _cognito.admin_create_user(
            UserPoolId=USER_POOL_ID, Username=username, MessageAction="SUPPRESS",
        )
    except _cognito.exceptions.UsernameExistsException:
        pass  # idempotent: re-running Update just re-applies password + group membership

    _cognito.admin_set_user_password(
        UserPoolId=USER_POOL_ID, Username=username, Password=password, Permanent=True,
    )
    for group in groups:
        _cognito.admin_add_user_to_group(
            UserPoolId=USER_POOL_ID, Username=username, GroupName=group,
        )


def _delete_user(username: str) -> None:
    try:
        _cognito.admin_delete_user(UserPoolId=USER_POOL_ID, Username=username)
    except _cognito.exceptions.UserNotFoundException:
        pass


def handler(event, context):
    request_type = event["RequestType"]
    props = event["ResourceProperties"]
    users = json.loads(props["Users"])  # [{"username": ..., "groups": [...]}]

    if request_type in ("Create", "Update"):
        # fetched only on this path: by Delete time the secret may already be gone,
        # and a failed lookup there would block stack teardown
        password = _password(props["PasswordSecretArn"])
        for user in users:
            _create_or_update_user(user["username"], password, user["groups"])
    elif request_type == "Delete":
        for user in users:
            _delete_user(user["username"])

    return {"PhysicalResourceId": f"{USER_POOL_ID}-demo-users"}
