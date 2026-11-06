from app.services.user import UserService


def test_update_user():
    service = UserService()
    service.update_user("u1", {"name": "Ada"})
