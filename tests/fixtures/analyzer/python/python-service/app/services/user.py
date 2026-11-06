from app.repositories.user import UserRepository


class UserService:
    def __init__(self):
        self.repo = UserRepository()

    def update_user(self, user_id, data):
        self.repo.update(user_id, data)
