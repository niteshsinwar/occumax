from enum import Enum as PyEnum


class RoomCategory(str, PyEnum):
    DELUXE = "DELUXE"
    SUITE = "SUITE"
    STUDIO = "STUDIO"
    STANDARD = "STANDARD"
    PREMIUM = "PREMIUM"
    ECONOMY = "ECONOMY"


class BlockType(str, PyEnum):
    HARD = "HARD"    # maintenance / in-house guest — immovable
    SOFT = "SOFT"    # future booking — movable within category
    EMPTY = "EMPTY"  # available


class Channel(str, PyEnum):
    OTA = "OTA"
    DIRECT = "DIRECT"
    GDS = "GDS"
    WALKIN = "WALKIN"
    CLOSED = "CLOSED"


class OfferType(str, PyEnum):
    SANDWICH_ORPHAN = "SANDWICH_ORPHAN"
    EXTENSION_OFFER = "EXTENSION_OFFER"
    LAST_MINUTE = "LAST_MINUTE"

