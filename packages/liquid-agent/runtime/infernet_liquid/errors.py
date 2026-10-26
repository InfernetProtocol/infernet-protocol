"""Failure taxonomy shared with src/contract.js ERROR_CODES."""

RETRIABLE = {"E_CAPACITY", "E_TIMEOUT", "E_RUNTIME"}


class LiquidError(Exception):
    def __init__(self, code, message, **extra):
        super().__init__(message)
        self.code = code
        self.extra = extra

    def to_json(self):
        return {"code": self.code, "message": str(self), "retriable": self.code in RETRIABLE, **self.extra}
