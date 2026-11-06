from .repositories.user import UserRepository
from . import models
from missing.module import Thing as MissingThing

router = object()
redis = object()
channel = object()
repository = UserRepository()


@router.websocket("/ws/events")
def events_socket(ws):
    redis.publish("events", "hello")


@router.route("/events", methods=["POST", "PUT"])
def write_event():
    channel.subscribe("events")
    return repository.query("SELECT * FROM users")


def item_detail(request):
    return request


def legacy_detail(request):
    return request


urlpatterns = [
    path("items/<int:pk>/", item_detail),
    re_path("^old/(?P<pk>[0-9]+)$", legacy_detail),
]
