FROM node:18-alpine as build

WORKDIR /usr/src/app/

COPY package*.json ./

RUN yarn --frozen-lockfile

COPY . .

RUN yarn run build

FROM node:18-alpine

WORKDIR /usr/src/app/

COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/node_modules ./node_modules

ENV PORT=80
ENV NODE_ENV=production

CMD ["node", "dist/main"]
