import React from "react";

function initials(name) {
  return String(name || "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map(function (p) { return p[0]; })
    .join("")
    .toUpperCase();
}

export function Avatar({ name = "", src, size = 28, className = "", ...rest }) {
  return (
    <span
      className={["ss-avatar", className].filter(Boolean).join(" ")}
      title={name}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) }}
      {...rest}
    >
      {/* The wrapper already fixes the box, so the image cannot shift layout —
          but width/height still stop it being laid out at 0×0 for a frame, and
          lazy+async keeps a wall of speaker avatars off the critical path.
          alt="" because the accessible name is on the wrapper's title: the
          image is decorative once the name is already announced. */}
      {src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}

export function AvatarGroup({ people = [], size = 26, max = 4 }) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span className="ss-avatar-group">
      {shown.map(function (p, i) {
        return <Avatar key={i} name={p.name} src={p.src} size={size} />;
      })}
      {rest > 0 ? <Avatar name={"+" + rest} size={size} /> : null}
    </span>
  );
}
