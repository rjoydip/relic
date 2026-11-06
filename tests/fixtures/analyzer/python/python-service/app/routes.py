from fastapi import FastAPI
from app.services.user import UserService

app = FastAPI()
service = UserService()


@app.get("/users/{user_id}")
def update_user(user_id: str, name: str):
    service.update_user(user_id, {"name": name})
    return {"id": user_id}
