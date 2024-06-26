import { ObjectId } from 'mongodb';
import { Model } from 'mongoose';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Portfolio } from '@portfolio/schemas';
import { PortfolioEntity, MongoPortfolioEntity } from '@portfolio/entities';
import { InjectTransactionsManagerDecorator } from '@core/decorators';
import { TransactionsManager } from '@core/managers';

interface FindPortfolioEntitiesParams {
  userId?: string;
  offerIds?: string[];
  isAwarded?: boolean;
}

export interface CreatePortfolioEntityParams {
  user: string;
  selectedTokens: string[];
  offer: string;
  isAwarded: boolean;
}

export interface UpdatePortfolioEntityParams {
  isAwarded?: boolean;
  earnedPoints?: number;
}

export interface PortfolioRepository {
  find(params: FindPortfolioEntitiesParams): Promise<PortfolioEntity[]>;
  existsByUserIdAndOfferId(userId: string, offerId: string): Promise<boolean>;
  create(params: CreatePortfolioEntityParams): Promise<PortfolioEntity>;
  updateOneById(id: string, params: UpdatePortfolioEntityParams): Promise<PortfolioEntity | null>;
}

@Injectable()
export class MongoPortfolioRepository implements PortfolioRepository {
  public constructor(
    @InjectModel(Portfolio.name) private portfolioModel: Model<Portfolio>,
    @InjectTransactionsManagerDecorator() private readonly transactionsManager: TransactionsManager,
  ) {}

  public async find(params: FindPortfolioEntitiesParams): Promise<PortfolioEntity[]> {
    const portfolioDocuments = await this.portfolioModel
      .find({
        ...(params.userId !== undefined ? { user: new ObjectId(params.userId) } : {}),
        ...(params.offerIds
          ? {
              offer: {
                $in: params.offerIds.map((offerId) => new ObjectId(offerId)),
              },
            }
          : {}),
        ...(params.isAwarded !== undefined ? { isAwarded: params.isAwarded } : {}),
      })
      .lean()
      .exec();

    return portfolioDocuments.map((portfolioDocument) => {
      return new MongoPortfolioEntity(portfolioDocument);
    });
  }

  public existsByUserIdAndOfferId(userId: string, offerId: string) {
    return this.portfolioModel
      .exists({
        user: new ObjectId(userId),
        offer: new ObjectId(offerId),
      })
      .exec() as unknown as Promise<boolean>;
  }

  public async create(params: CreatePortfolioEntityParams) {
    const portfolioDocument = await this.portfolioModel.create(params);

    return new MongoPortfolioEntity(portfolioDocument);
  }

  public async updateOneById(id: string, params: UpdatePortfolioEntityParams) {
    const portfolioDocument = await this.portfolioModel
      .findOneAndUpdate(
        {
          _id: new ObjectId(id),
        },
        params,
        { new: true, session: this.transactionsManager.getSession() },
      )
      .lean()
      .exec();

    return portfolioDocument && new MongoPortfolioEntity(portfolioDocument);
  }
}
