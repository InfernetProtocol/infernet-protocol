"""TemporalPolicy: a CfC, LTC or GRU core with an action-type head and a pointer over visible elements."""

import torch
from torch import nn

from .features import ACTION_TYPES, ELEMENT_DIM

PROJ_DIM = 64


class TemporalPolicy(nn.Module):
    def __init__(self, family, feature_dim, hidden_units, backbone_units=64):
        super().__init__()
        self.family = family
        self.feature_dim = feature_dim
        self.hidden_units = hidden_units
        self.backbone_units = backbone_units
        self.proj = nn.Linear(feature_dim, PROJ_DIM)
        if family == "cfc":
            from ncps.torch import CfCCell

            self.cell = CfCCell(PROJ_DIM, hidden_units, backbone_units=backbone_units, backbone_layers=1)
        elif family == "ltc":
            from ncps.torch import LTCCell
            from ncps.wirings import FullyConnected

            wiring = FullyConnected(hidden_units)
            wiring.build(PROJ_DIM)
            self.cell = LTCCell(wiring, PROJ_DIM, ode_unfolds=6, implicit_param_constraints=True)
        elif family == "gru":
            self.cell = nn.GRUCell(PROJ_DIM, hidden_units)
        else:
            raise ValueError(f"unknown family {family}")
        self.type_head = nn.Linear(hidden_units, len(ACTION_TYPES))
        self.elem_enc = nn.Linear(ELEMENT_DIM, hidden_units)
        self.query = nn.Linear(hidden_units, hidden_units)

    def init_state(self, batch):
        return torch.zeros(batch, self.hidden_units)

    def step(self, x, h, dt):
        """x [B,F], h [B,H], dt [B,1] seconds → (core output [B,H], new state [B,H])."""
        z = torch.tanh(self.proj(x))
        if self.family == "gru":
            h = self.cell(z, h)
            return h, h
        if self.family == "ltc":
            # The LTC solver divides by elapsed time; a zero gap (first step) would be inf.
            dt = dt.clamp(min=0.05)
        out, h = self.cell(z, h, dt)
        return out, h

    def heads(self, out, elems, elem_mask):
        """out [B,H]; elems [B,E,ELEMENT_DIM]; elem_mask [B,E] bool → (type logits [B,T], pointer logits [B,E])."""
        type_logits = self.type_head(out)
        keys = torch.tanh(self.elem_enc(elems))
        q = self.query(out).unsqueeze(1)
        ptr = (keys * q).sum(-1) / (self.hidden_units ** 0.5)
        ptr = ptr.masked_fill(~elem_mask, -1e9)
        return type_logits, ptr

    def param_count(self):
        return sum(p.numel() for p in self.parameters())
